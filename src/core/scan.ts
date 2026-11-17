import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CATEGORIES, roots, type CategoryId, type Root } from "./categories";

export interface Item {
  path: string;
  size: number;
  /** True for folders, which can be opened for a closer look. */
  dir?: boolean;
}

export interface ScanSnapshot {
  phase: "scanning" | "done";
  /** Capacity of the disk in bytes. */
  total: number;
  /** Free bytes, as the filesystem reports them. */
  available: number;
  /** total - available. While scanning, the sum measured so far. */
  used: number;
  sizes: Record<CategoryId, number>;
  /** Measured folders per category, largest first. */
  items: Record<CategoryId, Item[]>;
  /** Path being measured right now. */
  current: string;
  /** Folders macOS would not let this process read. */
  blocked: string[];
}

export interface ScanHandle {
  cancel(): void;
  done: Promise<ScanSnapshot>;
}

export function emptyRecord<T>(make: () => T): Record<CategoryId, T> {
  return Object.fromEntries(CATEGORIES.map((c) => [c.id, make()])) as Record<CategoryId, T>;
}

export function emptySnapshot(): ScanSnapshot {
  return {
    phase: "scanning",
    total: 0,
    available: 0,
    used: 0,
    sizes: emptyRecord(() => 0),
    items: emptyRecord<Item[]>(() => []),
    current: "",
    blocked: [],
  };
}

export async function diskSpace(): Promise<{ total: number; available: number }> {
  for (const path of ["/System/Volumes/Data", "/"]) {
    try {
      const s = await fsp.statfs(path);
      return { total: s.blocks * s.bsize, available: s.bavail * s.bsize };
    } catch {
      // try the next one
    }
  }
  return { total: 0, available: 0 };
}

function denied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EACCES";
}

const STALL_CHECK_MS = 5000;

interface DuResult {
  bytes: number;
  denied: boolean;
}

/** Disk usage of one folder via du, which is far faster than walking it in JS. */
export function du(path: string, children: Set<ChildProcess>): Promise<DuResult> {
  return new Promise((resolve) => {
    const child = spawn("du", ["-skx", path], { stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => {
      if (err.length < 4096) err += chunk;
    });
    // A folder guarded by a macOS privacy prompt (Music, TV, Photos) makes du
    // wait for an answer that may never come. A du that has used no CPU time
    // between two checks is waiting like that: give up on it and report the
    // folder as unreadable.
    let stalled = false;
    let lastCpu = "";
    const watchdog = setInterval(() => {
      if (child.pid === undefined) return;
      execFile("ps", ["-o", "cputime=", "-p", String(child.pid)], (error, stdout) => {
        const cpu = stdout.trim();
        if (error || cpu === "") return;
        if (cpu === lastCpu) {
          stalled = true;
          child.kill();
        }
        lastCpu = cpu;
      });
    }, STALL_CHECK_MS);

    const finish = () => {
      clearInterval(watchdog);
      children.delete(child);
      const kb = Number.parseInt(out, 10);
      resolve({
        bytes: Number.isFinite(kb) ? kb * 1024 : 0,
        denied: stalled || /not permitted|Permission denied/.test(err),
      });
    };
    child.on("error", finish);
    child.on("close", finish);
  });
}

interface Unit {
  path: string;
  category: Exclude<CategoryId, "system">;
}

export interface ScanOptions {
  home?: string;
  /** How many folders to measure at once. */
  concurrency?: number;
  /** Minimum milliseconds between onUpdate calls. */
  throttleMs?: number;
}

export function startScan(onUpdate: (snapshot: ScanSnapshot) => void, options: ScanOptions = {}): ScanHandle {
  const home = options.home ?? homedir();
  const concurrency = options.concurrency ?? 6;
  const throttleMs = options.throttleMs ?? 40;

  const snap = emptySnapshot();
  const children = new Set<ChildProcess>();
  let cancelled = false;
  let lastEmit = 0;

  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < throttleMs) return;
    lastEmit = now;
    onUpdate({ ...snap, sizes: { ...snap.sizes } });
  };

  const add = (category: CategoryId, bytes: number) => {
    snap.sizes[category] += bytes;
    snap.used += bytes;
  };

  const run = async (): Promise<ScanSnapshot> => {
    const space = await diskSpace();
    snap.total = space.total;
    snap.available = space.available;

    const all = roots(home);
    const rootPaths = new Set(all.map((r) => r.path));
    const holdsRoot = (path: string) => {
      const prefix = path + "/";
      return all.some((r) => r.path.startsWith(prefix));
    };

    const units: Unit[] = [];

    // Lists a folder, queueing each subfolder for du and adding loose files
    // straight away. Subfolders that hold another root are opened instead of
    // measured whole, so the inner root is not counted twice.
    const expand = async (path: string, category: Unit["category"], hidden?: Unit["category"]): Promise<void> => {
      if (cancelled) return;
      let entries;
      try {
        entries = await fsp.readdir(path, { withFileTypes: true });
      } catch (error) {
        if (denied(error)) snap.blocked.push(path);
        return;
      }
      for (const entry of entries) {
        const child = join(path, entry.name);
        if (rootPaths.has(child)) continue;
        const kind = hidden !== undefined && entry.name.startsWith(".") ? hidden : category;
        if (entry.isDirectory()) {
          if (holdsRoot(child)) await expand(child, kind);
          else units.push({ path: child, category: kind });
        } else {
          try {
            const stat = await fsp.lstat(child);
            const bytes = stat.blocks * 512;
            add(kind, bytes);
            if (bytes > 0) snap.items[kind].push({ path: child, size: bytes, dir: false });
          } catch {
            // vanished or unreadable; nothing to count
          }
        }
      }
    };

    const order = CATEGORIES.map((c) => c.id);
    const sorted: Root[] = [...all].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
    for (const root of sorted) {
      snap.current = root.path;
      await expand(root.path, root.category, root.hidden);
      emit();
    }

    let next = 0;
    const worker = async () => {
      while (!cancelled && next < units.length) {
        const unit = units[next++];
        snap.current = unit.path;
        emit();
        const result = await du(unit.path, children);
        if (cancelled) return;
        add(unit.category, result.bytes);
        if (result.bytes > 0) snap.items[unit.category].push({ path: unit.path, size: result.bytes, dir: true });
        if (result.denied && result.bytes < 1024 * 1024) snap.blocked.push(unit.path);
        emit();
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));

    for (const list of Object.values(snap.items)) list.sort((a, b) => b.size - a.size);

    // Whatever the disk reports as used beyond what was measured is the
    // system's: macOS itself, snapshots, swap, and folders this process may
    // not read.
    const after = await diskSpace();
    if (after.total > 0) {
      snap.total = after.total;
      snap.available = after.available;
      const used = after.total - after.available;
      const measured = snap.used;
      snap.sizes.system = Math.max(0, used - measured);
      snap.used = Math.max(used, measured);
    }
    snap.current = "";
    snap.phase = "done";
    emit(true);
    return snap;
  };

  return {
    cancel() {
      cancelled = true;
      for (const child of children) child.kill();
    },
    done: run(),
  };
}
