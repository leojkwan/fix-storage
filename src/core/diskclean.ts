import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Reads what the external disk-clean tool knows: its producer doctor and the
 * receipts its clean-up runs leave behind. Read-only: it runs the doctor and
 * reads files, and never changes anything on disk.
 */

export type Loaded<T> = { ok: true; value: T } | { ok: false; reason: string };

export type ProducerKind = "floor" | "target" | "setting" | "count";
export type ProducerState = "ok" | "fail" | "gap" | "unknown";
export type Route = "self" | "owner" | "reap";

export interface Producer {
  id: string;
  name: string;
  kind: ProducerKind;
  value: number | string | null;
  limit: number | string | null;
  state: ProducerState;
  owner: string;
  ticket: string;
  route: Route;
  fix: string;
}

export interface Free {
  gib: number;
  floor_gib: number;
  target_gib: number;
  gap_gib: number;
  state: string;
}

export interface Doctor {
  measured_at: string;
  free: Free;
  producers: Producer[];
  failing: number;
  unknown: number;
  healthy: boolean;
}

export interface Receipt {
  /** The receipt file or folder name; stable and unique. */
  id: string;
  /** The disk-clean tool that wrote it. */
  tool: string;
  mode: "plan" | "execute";
  /** When the run finished, ms since epoch; null when the receipt does not say. */
  at: number | null;
  /** The run's own state, e.g. "complete", "lock-timeout", "incomplete". */
  state: string;
  refusal: string | null;
  /** Change in free bytes reported by df across the run. Always null for a plan, which proves nothing. */
  freedBytes: number | null;
  /** Items by their final result, e.g. { removed: 6 } or { "would-remove": 6 }. */
  counts: Record<string, number>;
}

export interface DiskCleanSource {
  /** Where the data comes from, for the top line. */
  label: string;
  doctor(): Promise<Loaded<Doctor>>;
  receipts(limit?: number): Promise<Loaded<Receipt[]>>;
  /** Disk capacity in bytes, for the meter. The doctor reports only free space. */
  capacity(): Promise<Loaded<number>>;
  /** Stops a doctor run that is still going. */
  cancel(): void;
}

export const GIB = 2 ** 30;
export const DOCTOR_SCHEMA = "disk-clean.doctor/1";
export const DOCTOR_TIMEOUT_MS = 60_000;

const KINDS: ProducerKind[] = ["floor", "target", "setting", "count"];
const STATES: ProducerState[] = ["ok", "fail", "gap", "unknown"];
const ROUTES: Route[] = ["self", "owner", "reap"];

function expand(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

export function skillDir(env: NodeJS.ProcessEnv): string {
  return expand(env.DISK_CLEAN_SKILL_DIR || "~/.agents/skills/disk-clean");
}

export function stateDir(env: NodeJS.ProcessEnv): string {
  return expand(env.DISK_CLEAN_STATE_DIR || "~/.local/state/disk-clean");
}

// ---- doctor -------------------------------------------------------------------

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const scalar = (v: unknown): number | string | null => (num(v) || typeof v === "string" ? v : null);
const oneOf = <T extends string>(v: unknown, allowed: T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

/**
 * Turns the doctor's stdout and exit code into a reading. Exit 0 and 1 (some
 * producer fails) both carry the JSON; anything else, or output that is not the
 * expected schema, is unknown and never healthy.
 */
export function parseDoctor(stdout: string, exitCode: number | null): Loaded<Doctor> {
  if (exitCode !== 0 && exitCode !== 1) {
    return { ok: false, reason: exitCode === null ? "doctor was stopped by a signal" : `doctor exited ${exitCode}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: "doctor output is not JSON" };
  }
  if (!raw || typeof raw !== "object") return { ok: false, reason: "doctor output is not an object" };
  const r = raw as Record<string, unknown>;
  if (r.schema !== DOCTOR_SCHEMA) return { ok: false, reason: `doctor schema is ${JSON.stringify(r.schema)}, expected ${DOCTOR_SCHEMA}` };
  const f = r.free as Record<string, unknown> | undefined;
  if (!f || !num(f.gib) || !num(f.floor_gib) || !num(f.target_gib)) return { ok: false, reason: "doctor output has no free-space reading" };
  if (!Array.isArray(r.producers)) return { ok: false, reason: "doctor output has no producer list" };

  const producers: Producer[] = r.producers
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p) => ({
      id: str(p.id),
      name: str(p.name, str(p.id, "unnamed")),
      kind: oneOf(p.kind, KINDS, "count"),
      value: scalar(p.value),
      limit: scalar(p.limit),
      state: oneOf(p.state, STATES, "unknown"),
      owner: str(p.owner, "unowned") || "unowned",
      ticket: str(p.ticket),
      route: oneOf(p.route, ROUTES, "owner"),
      fix: str(p.fix),
    }));
  const count = (s: ProducerState) => producers.filter((p) => p.state === s).length;
  const failing = num(r.failing) ? r.failing : count("fail");
  const unknown = num(r.unknown) ? r.unknown : count("unknown");
  return {
    ok: true,
    value: {
      measured_at: str(r.measured_at),
      free: {
        gib: f.gib,
        floor_gib: f.floor_gib,
        target_gib: f.target_gib,
        gap_gib: num(f.gap_gib) ? f.gap_gib : Math.max(0, f.target_gib - f.gib),
        state: str(f.state, "unknown"),
      },
      producers,
      failing,
      unknown,
      // Healthy only when the doctor says so and nothing is failing or unknown.
      healthy: r.healthy === true && failing === 0 && unknown === 0,
    },
  };
}

/** Runs the doctor script. Resolves on our own timer so a stuck child can never hang the app. */
export function runDoctor(dir: string, timeoutMs = DOCTOR_TIMEOUT_MS): { done: Promise<Loaded<Doctor>>; cancel(): void } {
  const script = join(dir, "scripts", "producer-doctor.sh");
  let finish: (result: Loaded<Doctor>) => void = () => {};
  let settled = false;
  let timer: NodeJS.Timeout | null = null;
  const child = spawn("bash", [script, "--json"], { stdio: ["ignore", "pipe", "ignore"] });

  const stop = () => {
    child.stdout?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  const done = new Promise<Loaded<Doctor>>((resolve) => {
    finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
  });

  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.on("error", (error) => finish({ ok: false, reason: `could not run the doctor: ${error.message}` }));
  child.on("close", (code) => finish(parseDoctor(Buffer.concat(chunks).toString("utf8"), code)));
  timer = setTimeout(() => {
    stop();
    finish({ ok: false, reason: `doctor timed out after ${Math.round(timeoutMs / 1000)} s` });
  }, timeoutMs);

  return {
    done,
    cancel() {
      stop();
      finish({ ok: false, reason: "doctor run cancelled" });
    },
  };
}

// ---- receipts -----------------------------------------------------------------

const REAP_FILE = /^build-output-reap-.+-(plan|execute)\.json$/;
const WORKTREE_DIR = /^worktree-execute-[A-Za-z0-9._-]+$/;

function isoMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function bump(counts: Record<string, number>, key: string, by = 1) {
  counts[key] = (counts[key] ?? 0) + by;
}

/** One build-output-reap receipt (JSON). */
export function parseReapReceipt(id: string, text: string): Receipt {
  const fileMode = REAP_FILE.exec(id)?.[1] === "execute" ? "execute" : "plan";
  let r: Record<string, unknown>;
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object") throw new Error("not an object");
    r = raw as Record<string, unknown>;
  } catch {
    return { id, tool: "build-output-reap", mode: fileMode, at: null, state: "unreadable", refusal: null, freedBytes: null, counts: {} };
  }
  const mode = r.mode === "execute" || r.mode === "plan" ? r.mode : fileMode;
  const counts: Record<string, number> = {};
  if (Array.isArray(r.items)) {
    for (const item of r.items) {
      const decision = item && typeof item === "object" ? (item as Record<string, unknown>).decision : undefined;
      bump(counts, typeof decision === "string" && decision ? decision : "unrecorded");
    }
  }
  if (r.kept_counts && typeof r.kept_counts === "object") {
    for (const v of Object.values(r.kept_counts as Record<string, unknown>)) if (num(v) && v > 0) bump(counts, "kept", v);
  }
  if (Array.isArray(r.stranded) && r.stranded.length > 0) bump(counts, "stranded", r.stranded.length);

  // Freed space is what df saw between the start and the end of an execute run. A plan frees nothing.
  let freedBytes: number | null = null;
  if (mode === "execute") {
    if (num(r.free_start_bytes) && num(r.free_end_bytes)) freedBytes = r.free_end_bytes - r.free_start_bytes;
    else if (num(r.freed_total_bytes)) freedBytes = r.freed_total_bytes;
  }
  return {
    id,
    tool: str(r.tool, "build-output-reap") || "build-output-reap",
    mode,
    at: isoMs(r.finished_at) ?? isoMs(r.started_at),
    state: str(r.state, "unknown") || "unknown",
    refusal: typeof r.refusal === "string" && r.refusal ? r.refusal : null,
    freedBytes,
    counts,
  };
}

/**
 * One worktree execute receipt (TSV: time, path, result, detail, df_delta_bytes).
 * A path is counted once, by its last result. The TOTAL row carries the run's
 * df delta; without it the run did not finish and nothing is claimed.
 */
export function parseWorktreeReceipt(id: string, text: string): Receipt {
  const rows = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const last = new Map<string, string>();
  let total: string[] | null = null;
  let lastTime: number | null = null;
  for (const [index, line] of rows.entries()) {
    const cols = line.split("\t");
    if (index === 0 && cols[0] === "time") continue;
    const time = Number(cols[0]);
    if (Number.isFinite(time) && cols[0] !== "") lastTime = time * 1000;
    if (cols[1] === "TOTAL") {
      total = cols;
      continue;
    }
    if (cols.length >= 3 && cols[1]) last.set(cols[1], (cols[2] || "unrecorded").toLowerCase());
  }
  const counts: Record<string, number> = {};
  for (const result of last.values()) bump(counts, result);

  const delta = total ? Number(total[4]) : NaN;
  const totalTime = total ? Number(total[0]) * 1000 : NaN;
  return {
    id,
    tool: "worktree",
    mode: "execute",
    at: Number.isFinite(totalTime) ? totalTime : lastTime,
    state: total ? (total[2] || "done").toLowerCase() : "incomplete",
    refusal: null,
    freedBytes: total && total[4] !== undefined && total[4] !== "" && Number.isFinite(delta) ? delta : null,
    counts,
  };
}

/** Newest first; receipts without a time sort last. */
export function sortReceipts(receipts: Receipt[]): Receipt[] {
  return [...receipts].sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity) || b.id.localeCompare(a.id));
}

/** Bytes df saw freed across execute runs. Plans never count. */
export function freedTotal(receipts: Receipt[]): number {
  return receipts.reduce((sum, r) => (r.mode === "execute" && r.freedBytes !== null ? sum + r.freedBytes : sum), 0);
}

export async function readReceipts(dir: string, limit = 20): Promise<Loaded<Receipt[]>> {
  const receiptsDir = join(dir, "receipts");
  let names: string[];
  try {
    names = await fsp.readdir(receiptsDir);
  } catch {
    return { ok: false, reason: "no disk-clean receipts yet" };
  }
  const found: Receipt[] = [];
  for (const name of names) {
    if (REAP_FILE.test(name)) {
      try {
        found.push(parseReapReceipt(name, await fsp.readFile(join(receiptsDir, name), "utf8")));
      } catch {
        found.push(parseReapReceipt(name, ""));
      }
    } else if (WORKTREE_DIR.test(name)) {
      try {
        found.push(parseWorktreeReceipt(name, await fsp.readFile(join(receiptsDir, name, "receipt.tsv"), "utf8")));
      } catch {
        // A folder without a receipt is not a run we can say anything about.
      }
    }
  }
  return { ok: true, value: sortReceipts(found).slice(0, limit) };
}

async function diskCapacity(): Promise<Loaded<number>> {
  for (const path of ["/System/Volumes/Data", "/"]) {
    try {
      const s = await fsp.statfs(path);
      return { ok: true, value: s.blocks * s.bsize };
    } catch {
      // try the next one
    }
  }
  return { ok: false, reason: "could not read the disk's capacity" };
}

export interface SourceOptions {
  demo?: boolean;
  timeoutMs?: number;
}

export function diskCleanSource(env: NodeJS.ProcessEnv = process.env, options: SourceOptions = {}): DiskCleanSource {
  if (options.demo) return demoSource();
  const skill = skillDir(env);
  const state = stateDir(env);
  let running: ReturnType<typeof runDoctor> | null = null;
  return {
    label: "disk-clean",
    async doctor() {
      try {
        await fsp.access(join(skill, "scripts", "producer-doctor.sh"));
      } catch {
        return { ok: false, reason: "disk-clean doctor not found; set DISK_CLEAN_SKILL_DIR" };
      }
      running?.cancel();
      const run = runDoctor(skill, options.timeoutMs);
      running = run;
      const result = await run.done;
      if (running === run) running = null;
      return result;
    },
    receipts: (limit) => readReceipts(state, limit),
    capacity: diskCapacity,
    cancel() {
      running?.cancel();
      running = null;
    },
  };
}

// ---- demo -----------------------------------------------------------------------

const DEMO_NOW = Date.UTC(2026, 0, 15, 9, 30);
const HOUR = 3600 * 1000;

/** An invented machine: made-up producers, owners and tickets. */
export function demoDoctor(): Doctor {
  const producers: Producer[] = [
    { id: "free-floor", name: "Free space floor", kind: "floor", value: 38.4, limit: 50, state: "fail", owner: "Team A", ticket: "T-101", route: "self", fix: "run the build-output reaper" },
    { id: "free-target", name: "Free space target", kind: "target", value: 38.4, limit: 100, state: "gap", owner: "Team A", ticket: "T-102", route: "self", fix: "retire idle worktrees" },
    { id: "snapshots", name: "Local snapshots setting", kind: "setting", value: "thinned", limit: null, state: "ok", owner: "Team A", ticket: "T-103", route: "self", fix: "none needed" },
    { id: "build-output", name: "Idle build output folders", kind: "count", value: 14, limit: 4, state: "fail", owner: "Team B", ticket: "T-201", route: "reap", fix: "reap idle build output under the build lock" },
    { id: "worktrees", name: "Idle worktrees", kind: "count", value: 9, limit: 12, state: "ok", owner: "Team B", ticket: "T-202", route: "owner", fix: "owner retires merged worktrees" },
    { id: "simulators", name: "Unused simulator runtimes", kind: "count", value: 3, limit: 2, state: "fail", owner: "Team C", ticket: "T-301", route: "owner", fix: "owner removes old runtimes" },
    { id: "media-cache", name: "Media render cache", kind: "count", value: 0, limit: 5, state: "ok", owner: "Team C", ticket: "T-302", route: "owner", fix: "none needed" },
    { id: "model-store", name: "Local model store", kind: "count", value: 0, limit: 3, state: "unknown", owner: "Team D", ticket: "T-401", route: "owner", fix: "owner checks the model list" },
  ];
  return {
    measured_at: new Date(DEMO_NOW).toISOString(),
    free: { gib: 38.4, floor_gib: 50, target_gib: 100, gap_gib: 61.6, state: "below_floor" },
    producers,
    failing: producers.filter((p) => p.state === "fail").length,
    unknown: producers.filter((p) => p.state === "unknown").length,
    healthy: false,
  };
}

export function demoReceipts(): Receipt[] {
  const r = (hoursAgo: number, rest: Omit<Receipt, "at">): Receipt => ({ ...rest, at: DEMO_NOW - hoursAgo * HOUR });
  return sortReceipts([
    r(1, { id: "demo-reap-4-plan", tool: "build-output-reap", mode: "plan", state: "complete", refusal: null, freedBytes: null, counts: { "would-remove": 5 } }),
    r(3, { id: "demo-reap-3-execute", tool: "build-output-reap", mode: "execute", state: "lock-timeout", refusal: "demo lock was busy", freedBytes: -0.05 * GIB, counts: {} }),
    r(5, { id: "demo-worktree-2", tool: "worktree", mode: "execute", state: "done", refusal: null, freedBytes: 12.6 * GIB, counts: { removed: 18, skip: 7 } }),
    r(26, { id: "demo-reap-2-execute", tool: "build-output-reap", mode: "execute", state: "complete", refusal: null, freedBytes: 8.2 * GIB, counts: { removed: 6 } }),
    r(26.1, { id: "demo-reap-1-plan", tool: "build-output-reap", mode: "plan", state: "complete", refusal: null, freedBytes: null, counts: { "would-remove": 6 } }),
    r(50, { id: "demo-worktree-1", tool: "worktree", mode: "execute", state: "incomplete", refusal: null, freedBytes: null, counts: { removed: 2, removing: 1 } }),
  ]);
}

function demoSource(): DiskCleanSource {
  return {
    label: "demo",
    doctor: async () => ({ ok: true, value: demoDoctor() }),
    receipts: async (limit = 20) => ({ ok: true, value: demoReceipts().slice(0, limit) }),
    capacity: async () => ({ ok: true, value: 494 * GIB }),
    cancel() {},
  };
}
