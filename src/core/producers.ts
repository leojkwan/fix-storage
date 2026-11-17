import { GIB, type Doctor, type Loaded, type Producer, type ProducerState, type Receipt, type Route } from "./diskclean";

/**
 * What the Producers screen and the text modes both show, worked out once so
 * the two can never disagree. No UI imports here.
 */

export const STATE_TAG: Record<ProducerState, string> = { fail: "FAIL", gap: "GAP", unknown: "UNKNOWN", ok: "OK" };
export const ROUTE_TAG: Record<Route, string> = { self: "SELF", owner: "OWNER", reap: "REAP" };

/** Failing first, then gaps, then what could not be measured, then healthy. */
const STATE_ORDER: Record<ProducerState, number> = { fail: 0, gap: 1, unknown: 2, ok: 3 };

export interface OwnerGroup {
  owner: string;
  producers: Producer[];
  /** Producers in state "fail" only, matching the doctor's own failing count. */
  failing: number;
  gaps: number;
  unknown: number;
}

export function sortProducers(producers: Producer[]): Producer[] {
  return [...producers].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name));
}

/** One group per owner, the owners with the most failing first. */
export function groupByOwner(doctor: Doctor): OwnerGroup[] {
  const byOwner = new Map<string, Producer[]>();
  for (const p of doctor.producers) byOwner.set(p.owner, [...(byOwner.get(p.owner) ?? []), p]);
  const groups = [...byOwner.entries()].map(([owner, list]) => ({
    owner,
    producers: sortProducers(list),
    failing: list.filter((p) => p.state === "fail").length,
    gaps: list.filter((p) => p.state === "gap").length,
    unknown: list.filter((p) => p.state === "unknown").length,
  }));
  return groups.sort((a, b) => b.failing - a.failing || b.gaps - a.gaps || b.unknown - a.unknown || a.owner.localeCompare(b.owner));
}

// ---- numbers ----------------------------------------------------------------------

const trim = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** "38.4 GiB". */
export function gib(value: number): string {
  return `${trim(Math.round(value * 10) / 10)} GiB`;
}

/** Signed size from bytes, binary units: "+8.2 GiB", "-52 MiB". Never clamps. */
export function signedBytes(bytes: number): string {
  const sign = bytes > 0 ? "+" : bytes < 0 ? "-" : "";
  const abs = Math.abs(bytes);
  if (abs >= GIB) return `${sign}${(abs / GIB).toFixed(1)} GiB`;
  if (abs >= 2 ** 20) return `${sign}${Math.round(abs / 2 ** 20)} MiB`;
  return `${sign}${Math.round(abs / 1024)} KiB`;
}

/** "14 / 4", "38.4 GiB / 50 GiB", "thinned". */
export function valueText(p: Producer): string {
  const show = (v: number | string | null) =>
    v === null ? "?" : typeof v === "number" ? (p.kind === "floor" || p.kind === "target" ? gib(v) : trim(v)) : v;
  if (p.limit === null) return show(p.value);
  const sep = p.kind === "floor" ? " ≥ " : p.kind === "target" ? " → " : " / ";
  return `${show(p.value)}${sep}${show(p.limit)}`;
}

/** "Team A · T-101 · run the reaper". */
export function reasonLine(p: Producer): string {
  return [p.owner, p.ticket, p.fix].filter((s) => s && s.trim() !== "").join(" · ");
}

/** "38.4 GiB free · floor 50 · target 100 · gap 61.6". */
export function totalsLine(doctor: Doctor): string {
  const f = doctor.free;
  return `${gib(f.gib)} free · floor ${trim(f.floor_gib)} · target ${trim(f.target_gib)} · gap ${trim(Math.round(f.gap_gib * 10) / 10)}`;
}

/** "3 failing · 1 unknown", or "healthy". Unknown is never healthy. */
export function healthLine(doctor: Doctor): string {
  if (doctor.healthy) return "healthy";
  const parts = [`${doctor.failing} failing`];
  if (doctor.unknown > 0) parts.push(`${doctor.unknown} unknown`);
  return parts.join(" · ");
}

// ---- meter --------------------------------------------------------------------------

export interface MeterMarks {
  /** Shares of the whole disk, 0..1. */
  used: number;
  floor: number;
  target: number;
}

/** Where used space ends and where the floor and target sit, measured from the right as free space. */
export function meterMarks(doctor: Doctor, capacityBytes: number): MeterMarks | null {
  const total = capacityBytes / GIB;
  if (!(total > 0)) return null;
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  return {
    used: clamp(1 - doctor.free.gib / total),
    floor: clamp(1 - doctor.free.floor_gib / total),
    target: clamp(1 - doctor.free.target_gib / total),
  };
}

// ---- receipts -------------------------------------------------------------------------

export function when(at: number | null): string {
  if (at === null) return "time unknown";
  return new Date(at).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

/** "freed +8.2 GiB by df", "plan only, not proof", "no df total". */
export function freedText(r: Receipt): string {
  if (r.mode === "plan") return "plan only, not proof";
  if (r.freedBytes === null) return "no df total";
  return `df ${signedBytes(r.freedBytes)}`;
}

/** "removed 18 · skip 7". */
export function countsText(r: Receipt): string {
  const entries = Object.entries(r.counts).filter(([, n]) => n > 0);
  return entries.length === 0 ? "no items" : entries.map(([k, n]) => `${k} ${n}`).join(" · ");
}

/** State, with the refusal when there is one: "lock-timeout: build lock not acquired". */
export function stateText(r: Receipt): string {
  return r.refusal ? `${r.state}: ${r.refusal}` : r.state;
}

// ---- text and JSON output -------------------------------------------------------------

export interface Summary {
  doctor: Loaded<Doctor>;
  receipts: Loaded<Receipt[]>;
}

export function summaryJson({ doctor, receipts }: Summary): string {
  const out = {
    doctor: doctor.ok
      ? {
          state: doctor.value.healthy ? "healthy" : "unhealthy",
          measured_at: doctor.value.measured_at,
          free: doctor.value.free,
          failing: doctor.value.failing,
          unknown: doctor.value.unknown,
          owners: groupByOwner(doctor.value).map((g) => ({ owner: g.owner, failing: g.failing })),
        }
      : { state: "unknown", reason: doctor.reason },
    producers: doctor.ok ? sortProducers(doctor.value.producers) : [],
    receipts: receipts.ok
      ? receipts.value.map((r) => ({
          tool: r.tool,
          mode: r.mode,
          at: r.at === null ? null : new Date(r.at).toISOString(),
          state: r.state,
          refusal: r.refusal,
          freed_df_bytes: r.mode === "execute" ? r.freedBytes : null,
          counts: r.counts,
        }))
      : [],
    receipts_error: receipts.ok ? null : receipts.reason,
  };
  return JSON.stringify(out, null, 2) + "\n";
}

export function summaryText({ doctor, receipts }: Summary): string {
  const lines: string[] = [];
  if (!doctor.ok) {
    lines.push(`Producers: UNKNOWN · ${doctor.reason}`);
  } else {
    const d = doctor.value;
    lines.push(totalsLine(d), `Producers: ${healthLine(d)} · measured ${d.measured_at}`);
    for (const group of groupByOwner(d)) {
      lines.push("", `${group.owner}  ${group.failing} failing`);
      const width = Math.max(...group.producers.map((p) => p.name.length));
      for (const p of group.producers) {
        lines.push(`  ${STATE_TAG[p.state].padEnd(7)}  ${p.name.padEnd(width)}  ${valueText(p)}  [${ROUTE_TAG[p.route]}]`);
        lines.push(`  ${"".padEnd(7)}  ${reasonLine(p)}`);
      }
    }
  }
  lines.push("", "Receipts (newest first)");
  if (!receipts.ok) lines.push(`  ${receipts.reason}`);
  else if (receipts.value.length === 0) lines.push("  none");
  else {
    for (const r of receipts.value) {
      lines.push(`  ${when(r.at)}  ${r.tool} ${r.mode}  ${stateText(r)}  ${freedText(r)}  ${countsText(r)}`);
    }
  }
  return lines.join("\n") + "\n";
}
