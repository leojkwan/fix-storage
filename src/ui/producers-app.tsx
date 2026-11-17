import { Box, useRect } from "@zenbu-labs/pixel";
import type { Color, NodeHandle, Root } from "@zenbu-labs/pixel";
import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { Rgb } from "../core/categories";
import type { Doctor, Producer, ProducerState, Receipt, Route } from "../core/diskclean";
import {
  countsText,
  freedText,
  gib,
  healthLine,
  meterMarks,
  reasonLine,
  ROUTE_TAG,
  STATE_TAG,
  stateText,
  valueText,
  when,
  type MeterMarks,
} from "../core/producers";
import { AMBER, BG, ch, Dots, FAINT, FG, GREEN, Hint, MUTED, rgba, Sep, T } from "./app";
import { BAR_ROWS, BarCanvas, HEADROOM_ROWS, type BarModel } from "./bar";
import { entryKey, type Entry, type ProducersState, type ProducersStore } from "./producers-store";

// Same face, colours and two-pane layout as the folder browser.

const RED: Color = "#f87171";
const BLUE: Color = "#60a5fa";
const RED_RGB: Rgb = [248, 113, 113];
const AMBER_RGB: Rgb = [251, 191, 36];
const GREEN_RGB: Rgb = [74, 222, 128];

const STATE_COLOR: Record<ProducerState, Color> = { fail: RED, gap: AMBER, unknown: BLUE, ok: GREEN };
const STATE_RGB: Record<ProducerState, Rgb> = { fail: RED_RGB, gap: AMBER_RGB, unknown: [96, 165, 250], ok: GREEN_RGB };
const ROUTE_COLOR: Record<Route, Color> = { self: FG, owner: MUTED, reap: AMBER };

interface Ctx {
  state: ProducersState;
  store: ProducersStore;
  fs: number;
}

/** Colour of the used part of the meter: red below the floor, amber below the target. */
function usedColor(doctor: Doctor): Rgb {
  const f = doctor.free;
  return f.gib < f.floor_gib ? RED_RGB : f.gib < f.target_gib ? AMBER_RGB : GREEN_RGB;
}

function marksFor(state: ProducersState): { doctor: Doctor; marks: MeterMarks } | null {
  if (!state.doctor?.ok || state.capacity === null) return null;
  const marks = meterMarks(state.doctor.value, state.capacity);
  return marks ? { doctor: state.doctor.value, marks } : null;
}

// ---- the meter --------------------------------------------------------------------

function barModel(state: ProducersState): BarModel {
  const known = marksFor(state);
  if (!known) return { segments: [], hover: null, scanning: state.loading, clearing: null };
  const { doctor, marks } = known;
  return {
    segments: [{ id: "used", color: usedColor(doctor), fraction: marks.used }],
    hover: null,
    scanning: false,
    clearing: null,
    marks: [
      { fraction: marks.floor, color: RED_RGB },
      { fraction: marks.target, color: AMBER_RGB },
    ],
  };
}

function Meter({ root, store, fs }: { root: Root; store: ProducersStore; fs: number }) {
  const ref = useRef<NodeHandle>(null);
  const rect = useRect(ref);
  const surface = useMemo(() => root.createSurface(), [root]);
  const canvas = useMemo(() => new BarCanvas(surface, BG), [surface]);
  const cell = Math.max(4, Math.round(fs * 0.62));
  const height = (BAR_ROWS + HEADROOM_ROWS) * cell;

  useEffect(() => {
    if (rect) canvas.resize(rect.width, rect.height, cell);
  }, [canvas, rect?.width, rect?.height, cell]);

  useEffect(() => {
    let last = Date.now();
    let idle = 0;
    const timer = setInterval(() => {
      const now = Date.now();
      if (idle > 0 && --idle > 0) return;
      canvas.setModel(barModel(store.get()));
      const moving = canvas.step((now - last) / 1000);
      last = now;
      idle = moving ? 0 : 6;
    }, 16);
    return () => {
      clearInterval(timer);
      surface.close();
    };
  }, [canvas, store, surface]);

  return <Box ref={ref} surface={surface} style={{ width: "100%", height, flexShrink: 0 }} />;
}

/** Character fallback: used, then free, with the floor and target as thin coloured bars. */
function CellMeter({ state, fs }: { state: ProducersState; fs: number }) {
  const known = marksFor(state);
  const height = fs * 1.4;
  if (!known) return <Box style={{ width: "100%", height, flexShrink: 0, background: "#141414" }} />;
  const { doctor, marks } = known;
  const stops = [
    { at: marks.used, mark: null as Color | null },
    { at: marks.floor, mark: RED },
    { at: marks.target, mark: AMBER },
  ].sort((a, b) => a.at - b.at);
  const parts: ReactNode[] = [];
  let from = 0;
  for (const [i, stop] of stops.entries()) {
    const fill = from < marks.used ? rgba(usedColor(doctor), 0.7) : "#141414";
    parts.push(<Box key={`s${i}`} style={{ flexGrow: Math.max(0, stop.at - from), flexBasis: 0, background: fill }} />);
    if (stop.mark) parts.push(<Box key={`m${i}`} style={{ width: Math.max(2, fs * 0.25), flexShrink: 0, background: stop.mark }} />);
    from = Math.max(from, stop.at);
  }
  parts.push(<Box key="rest" style={{ flexGrow: Math.max(0, 1 - from), flexBasis: 0, background: "#141414" }} />);
  return <Box style={{ width: "100%", height, flexShrink: 0 }}>{parts}</Box>;
}

// ---- top lines -----------------------------------------------------------------------

function TopLine({ state, store, fs }: Ctx) {
  let status: ReactNode;
  if (state.loading) status = <T fs={fs} color={FG}>asking the doctor…</T>;
  else if (!state.doctor) status = <T fs={fs} color={FAINT}>not read yet</T>;
  else if (!state.doctor.ok) status = <T fs={fs} color={BLUE} style={{ flexShrink: 1, ellipsis: true }}>{`doctor unknown · ${state.doctor.reason}`}</T>;
  else {
    const d = state.doctor.value;
    status = (
      <>
        <T fs={fs} color={d.healthy ? GREEN : d.failing > 0 ? RED : BLUE} bold>{healthLine(d)}</T>
        <T fs={fs} color={FAINT} style={{ flexShrink: 1, ellipsis: true, margin: { left: ch(fs, 2) } }}>{`measured ${when(Date.parse(d.measured_at) || null)}`}</T>
      </>
    );
  }
  return (
    <Box style={{ justifyContent: "space-between", gap: fs * 2, flexShrink: 0 }}>
      <Box style={{ flexShrink: 0 }}>
        <T fs={fs} bold>fix-storage</T>
        <T fs={fs} color={FAINT} style={{ margin: { left: ch(fs, 2) } }}>producers</T>
        {store.options.demo ? <T fs={fs} color={AMBER} style={{ margin: { left: ch(fs, 2) } }}>demo data</T> : null}
      </Box>
      <Box style={{ flexShrink: 1, minWidth: 0, justifyContent: "end" }}>{status}</Box>
    </Box>
  );
}

/** "N GiB free · floor F · target T · gap G", the floor and target in their mark colours. */
function Totals({ state, fs }: Ctx) {
  if (!state.doctor?.ok) {
    return (
      <Box style={{ flexShrink: 0 }}>
        <T fs={fs} bold color={BLUE}>free space unknown</T>
        <T fs={fs} color={MUTED} style={{ margin: { left: ch(fs, 2) } }}>never read as healthy</T>
      </Box>
    );
  }
  const f = state.doctor.value.free;
  const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  return (
    <Box style={{ flexShrink: 0 }}>
      <T fs={fs} bold color={f.gib < f.floor_gib ? RED : f.gib < f.target_gib ? AMBER : FG}>{gib(f.gib)}</T>
      <T fs={fs} color={MUTED}>{" free"}</T>
      <Sep fs={fs} />
      <T fs={fs} color={RED}>{"│ "}</T>
      <T fs={fs} color={MUTED}>{"floor "}</T>
      <T fs={fs}>{n(f.floor_gib)}</T>
      <Sep fs={fs} />
      <T fs={fs} color={AMBER}>{"│ "}</T>
      <T fs={fs} color={MUTED}>{"target "}</T>
      <T fs={fs}>{n(f.target_gib)}</T>
      <Sep fs={fs} />
      <T fs={fs} color={MUTED}>{"gap "}</T>
      <T fs={fs} color={f.gap_gib > 0 ? AMBER : FG}>{n(Math.round(f.gap_gib * 10) / 10)}</T>
    </Box>
  );
}

// ---- left pane ---------------------------------------------------------------------------

function entryLabel(entry: Entry): { name: string; detail: string; color: Color } {
  if (entry.kind === "overview") return { name: "Overview", detail: "", color: FG };
  if (entry.kind === "receipts") return { name: "Receipts", detail: "", color: FG };
  const g = entry.group;
  const color = g.failing > 0 ? RED : g.gaps > 0 ? AMBER : g.unknown > 0 ? BLUE : GREEN;
  return { name: g.owner, detail: `${g.failing} failing`, color };
}

function EntryLine({ entry, state, store, fs }: Ctx & { entry: Entry }) {
  const key = entryKey(entry);
  const selected = state.selected === key;
  const focused = selected && state.pane === "sidebar";
  const { name, detail, color } = entryLabel(entry);
  const dimmed = state.hover !== null && state.hover !== key && !selected;
  const group = entry.kind === "owner" ? entry.group : null;
  return (
    <Box
      style={{ alignItems: "center", gap: fs * 0.6, height: fs * 1.75, flexShrink: 0, pointerShape: "pointer" }}
      onClick={() => store.select(key, "list")}
      onMouseEnter={() => store.setHover(key)}
      onMouseLeave={() => store.setHover(null)}
    >
      <T fs={fs} color={selected ? color : FAINT} bold style={{ width: ch(fs, 1) }}>
        {focused ? "›" : selected ? "·" : ""}
      </T>
      <T fs={fs} color={group ? color : FAINT} style={{ width: ch(fs, 1) }}>{group ? "■" : ""}</T>
      <T fs={fs} color={selected ? FG : dimmed ? FAINT : "#b5b5b5"} bold={selected} style={{ width: ch(fs, 14), ellipsis: true }}>
        {name}
      </T>
      <T fs={fs} color={group && group.failing > 0 ? RED : MUTED} style={{ width: ch(fs, 9) }}>{detail.padStart(9)}</T>
      {group ? (
        <Dots fraction={group.producers.length ? group.failing / group.producers.length : 0} color={STATE_RGB.fail} count={8} fs={fs} seed={name.length * 7 + name.charCodeAt(0)} dim={dimmed} />
      ) : null}
    </Box>
  );
}

function Sidebar(ctx: Ctx & { width: number }) {
  const { state, store, fs, width } = ctx;
  const entries = store.entries();
  const owners = entries.filter((e) => e.kind === "owner");
  return (
    <Box style={{ flexDirection: "column", width, flexShrink: 0, gap: fs * 0.2 }}>
      <T fs={fs} color={state.pane === "sidebar" ? MUTED : FAINT} style={{ margin: { bottom: fs * 0.4, left: ch(fs, 2) } }}>
        owners
      </T>
      <EntryLine {...ctx} entry={entries[0]} />
      {owners.map((entry) => (
        <EntryLine key={entryKey(entry)} {...ctx} entry={entry} />
      ))}
      {owners.length === 0 ? (
        <T fs={fs} color={FAINT} style={{ margin: { left: ch(fs, 4) } }}>{state.loading ? "reading…" : "no owners known"}</T>
      ) : null}
      <EntryLine {...ctx} entry={entries[entries.length - 1]} />
      <Box style={{ flexGrow: 1 }} />
    </Box>
  );
}

// ---- right pane ---------------------------------------------------------------------------

function Tag({ text, color, fs, width }: { text: string; color: Color; fs: number; width: number }) {
  return (
    <T fs={fs} color={color} bold style={{ width: ch(fs, width) }}>
      {text}
    </T>
  );
}

function ProducerLine({ producer, index, rowRef, ...ctx }: Ctx & { producer: Producer; index: number; rowRef: (node: NodeHandle | null) => void }) {
  const { state, store, fs } = ctx;
  const selected = state.row === index;
  const focused = selected && state.pane === "list";
  return (
    <Box ref={rowRef} style={{ flexDirection: "column", flexShrink: 0, pointerShape: "pointer" }} onClick={() => store.setRow(index)}>
      <Box style={{ alignItems: "center", gap: ch(fs, 1), height: fs * 1.6, flexShrink: 0 }}>
        <T fs={fs} color={focused ? STATE_COLOR[producer.state] : FAINT} bold style={{ width: ch(fs, 1) }}>
          {focused ? "›" : selected ? "·" : ""}
        </T>
        <Tag text={STATE_TAG[producer.state]} color={STATE_COLOR[producer.state]} fs={fs} width={7} />
        <T fs={fs} color={selected ? FG : "#b5b5b5"} bold={selected} style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, ellipsis: true }}>
          {producer.name}
        </T>
        <T fs={fs} color={selected ? FG : MUTED}>{valueText(producer)}</T>
        <Tag text={ROUTE_TAG[producer.route]} color={ROUTE_COLOR[producer.route]} fs={fs} width={6} />
      </Box>
      <Box style={{ alignItems: "center", height: fs * 1.4, flexShrink: 0, padding: { left: ch(fs, 10) }, overflow: "hidden" }}>
        <T fs={fs} color={FAINT} style={{ flexShrink: 1, ellipsis: true }}>{reasonLine(producer)}</T>
      </Box>
    </Box>
  );
}

function ReceiptLine({ receipt, index, rowRef, ...ctx }: Ctx & { receipt: Receipt; index: number; rowRef: (node: NodeHandle | null) => void }) {
  const { state, store, fs } = ctx;
  const selected = state.row === index;
  const focused = selected && state.pane === "list";
  const plan = receipt.mode === "plan";
  const freedColor = plan || receipt.freedBytes === null ? FAINT : receipt.freedBytes > 0 ? GREEN : AMBER;
  const stateColor = receipt.refusal || !/^(complete|done)$/.test(receipt.state) ? AMBER : MUTED;
  return (
    <Box ref={rowRef} style={{ flexDirection: "column", flexShrink: 0, pointerShape: "pointer" }} onClick={() => store.setRow(index)}>
      <Box style={{ alignItems: "center", gap: ch(fs, 1), height: fs * 1.6, flexShrink: 0 }}>
        <T fs={fs} color={focused ? FG : FAINT} bold style={{ width: ch(fs, 1) }}>
          {focused ? "›" : selected ? "·" : ""}
        </T>
        <T fs={fs} color={MUTED} style={{ width: ch(fs, 18) }}>{when(receipt.at)}</T>
        <T fs={fs} color={selected ? FG : "#b5b5b5"} bold={selected} style={{ width: ch(fs, 18), ellipsis: true }}>{receipt.tool}</T>
        <Tag text={plan ? "PLAN" : "EXECUTE"} color={plan ? FAINT : FG} fs={fs} width={8} />
        <T fs={fs} color={stateColor} style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, ellipsis: true }}>{stateText(receipt)}</T>
        <T fs={fs} color={freedColor} bold={!plan && receipt.freedBytes !== null}>{freedText(receipt)}</T>
      </Box>
      <Box style={{ alignItems: "center", height: fs * 1.4, flexShrink: 0, padding: { left: ch(fs, 21) }, overflow: "hidden" }}>
        <T fs={fs} color={FAINT} style={{ flexShrink: 1, ellipsis: true }}>{countsText(receipt)}</T>
      </Box>
    </Box>
  );
}

function Note({ fs, children, color = FAINT }: { fs: number; children: ReactNode; color?: Color }) {
  return (
    <T fs={fs} color={color} style={{ margin: { top: fs * 0.6, left: ch(fs, 4) }, wrap: true, flexShrink: 1 }}>
      {children}
    </T>
  );
}

function Detail(ctx: Ctx) {
  const { state, store, fs } = ctx;
  const entry = store.current();
  const rows = useRef<Array<NodeHandle | null>>([]);

  useEffect(() => {
    rows.current[state.row]?.scrollIntoView(false);
  }, [state.row, state.selected]);

  let title: string;
  let subtitle: string;
  let body: ReactNode;
  if (entry.kind === "receipts") {
    title = "Receipts";
    subtitle = "newest first · freed space is what df saw during an execute run; a plan proves nothing";
    const receipts = state.receipts;
    if (!receipts) body = <Note fs={fs}>reading receipts…</Note>;
    else if (!receipts.ok) body = <Note fs={fs}>{receipts.reason}</Note>;
    else if (receipts.value.length === 0) body = <Note fs={fs}>no receipts yet</Note>;
    else
      body = receipts.value.map((receipt, index) => (
        <ReceiptLine key={receipt.id} {...ctx} receipt={receipt} index={index} rowRef={(node) => (rows.current[index] = node)} />
      ));
  } else {
    const producers = store.producers();
    if (entry.kind === "owner") {
      const g = entry.group;
      title = g.owner;
      subtitle = `${g.producers.length} producers · ${g.failing} failing${g.gaps ? ` · ${g.gaps} gap` : ""}${g.unknown ? ` · ${g.unknown} unknown` : ""}`;
    } else {
      title = "Overview";
      subtitle = state.doctor?.ok ? `${healthLine(state.doctor.value)} · everything not OK, failing first` : "what needs attention";
    }
    if (!state.doctor) body = <Note fs={fs}>asking the doctor…</Note>;
    else if (!state.doctor.ok)
      body = (
        <Note fs={fs} color={BLUE}>
          {`UNKNOWN · ${state.doctor.reason}. Treated as not healthy. r to try again.`}
        </Note>
      );
    else if (producers.length === 0) body = <Note fs={fs}>{entry.kind === "overview" ? "every producer is OK" : "no producers"}</Note>;
    else
      body = producers.map((producer, index) => (
        <ProducerLine key={producer.id || `${producer.name}-${index}`} {...ctx} producer={producer} index={index} rowRef={(node) => (rows.current[index] = node)} />
      ));
  }

  return (
    <Box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, minWidth: 0, gap: fs * 0.2 }}>
      <Box style={{ flexDirection: "column", gap: fs * 0.35, flexShrink: 0 }}>
        <T fs={fs} bold>{title}</T>
        <T fs={fs} color={FAINT} style={{ flexShrink: 1, ellipsis: true }}>{subtitle}</T>
      </Box>
      <Box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, overflow: "scroll", margin: { top: fs * 0.7 }, scrollbar: { width: 3, thumbColor: "#2a2a2a" } }}>
        {body}
      </Box>
    </Box>
  );
}

// ---- bottom line ---------------------------------------------------------------------------

function BottomLine({ state, store, fs }: Ctx) {
  const keys: Array<[string, string, (() => void) | undefined]> =
    state.pane === "list"
      ? [["↑↓", "move", undefined], ["←", "owners", () => store.setPane("sidebar")], ["r", "reload", () => store.reload()], ["q", "quit", undefined]]
      : [["↑↓", "owner", undefined], ["→", "look inside", () => store.setPane("list")], ["r", "reload", () => store.reload()], ["q", "quit", undefined]];
  return (
    <Box style={{ justifyContent: "space-between", gap: fs * 2, flexShrink: 0 }}>
      <Box style={{ gap: fs * 1.4, flexShrink: 0 }}>
        {keys.map(([k, label, onClick]) => (
          <Hint key={k} fs={fs} k={k} label={label} color={FAINT} keyColor={MUTED} onClick={onClick} />
        ))}
      </Box>
      <T fs={fs} color={FAINT} style={{ flexShrink: 1, ellipsis: true }}>read-only · no key cleans anything</T>
    </Box>
  );
}

// ---- app --------------------------------------------------------------------------------------

export function ProducersApp({ root, store }: { root: Root; store: ProducersStore }) {
  const state = useSyncExternalStore(store.subscribe, store.get);
  const info = root.info;
  const cells = info.renderer === "cells";
  const fs = Math.round(info.basePx * 0.85);
  const ctx: Ctx = { state, store, fs };
  // 1 + 1 + 14 + 9 characters, eight dots, and the gaps between them.
  const left = fs * 0.6 * 25 + fs * 0.6 * 4 + 8 * (Math.max(2, Math.round(fs * 0.26)) + Math.max(1, Math.round(fs * 0.14)));

  return (
    <Box
      style={{
        flexDirection: "column",
        width: "100%",
        height: "100%",
        background: BG,
        padding: { top: fs * 0.8, bottom: fs * 0.8, left: fs * 1.2, right: fs * 1.2 },
        gap: fs * 0.5,
      }}
    >
      <TopLine {...ctx} />
      <Box style={{ height: fs * 0.4, flexShrink: 0 }} />
      <Totals {...ctx} />
      {cells ? <CellMeter state={state} fs={fs} /> : <Meter root={root} store={store} fs={fs} />}
      <Box style={{ flexGrow: 1, flexShrink: 1, gap: fs * 3, margin: { top: fs * 0.8 }, minWidth: 0 }}>
        <Sidebar {...ctx} width={left} />
        <Detail {...ctx} />
      </Box>
      <BottomLine {...ctx} />
    </Box>
  );
}
