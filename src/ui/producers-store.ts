import type { DiskCleanSource, Doctor, Loaded, Producer, Receipt } from "../core/diskclean";
import { groupByOwner, sortProducers, type OwnerGroup } from "../core/producers";

/** Which side of the screen the arrow keys move in. */
export type Pane = "sidebar" | "list";

/** A line in the left pane: the overview, one owner, or the receipts. */
export type Entry = { kind: "overview" } | { kind: "owner"; group: OwnerGroup } | { kind: "receipts" };

export interface ProducersState {
  /** null until the first reading arrives. */
  doctor: Loaded<Doctor> | null;
  receipts: Loaded<Receipt[]> | null;
  /** Disk capacity in bytes, for the meter; null when unknown. */
  capacity: number | null;
  loading: boolean;
  /** Key of the selected left-pane entry: "overview", "receipts" or "owner:<name>". */
  selected: string;
  hover: string | null;
  pane: Pane;
  row: number;
}

type Listener = () => void;

export const entryKey = (entry: Entry): string => (entry.kind === "owner" ? `owner:${entry.group.owner}` : entry.kind);

/** State for the Producers screen. It reads and never acts: no key here cleans anything. */
export class ProducersStore {
  private state: ProducersState = {
    doctor: null,
    receipts: null,
    capacity: null,
    loading: false,
    selected: "overview",
    hover: null,
    pane: "sidebar",
    row: 0,
  };
  private listeners = new Set<Listener>();
  private token = 0;

  constructor(
    readonly source: DiskCleanSource,
    readonly options: { demo: boolean },
  ) {}

  get = (): ProducersState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<ProducersState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Runs the doctor and reads receipts again. A newer reload supersedes an older one. */
  reload() {
    const token = ++this.token;
    this.source.cancel();
    this.set({ loading: true });
    void Promise.all([this.source.doctor(), this.source.receipts(), this.source.capacity()]).then(([doctor, receipts, capacity]) => {
      if (token !== this.token) return;
      // Replace everything, so an unknown reading never leaves an older healthy one on screen.
      this.set({ doctor, receipts, capacity: capacity.ok ? capacity.value : null, loading: false });
      this.clamp();
    });
  }

  stop() {
    this.token++;
    this.source.cancel();
  }

  // ---- what is listed ---------------------------------------------------------

  entries(state: ProducersState = this.state): Entry[] {
    const owners = state.doctor?.ok ? groupByOwner(state.doctor.value).map((group) => ({ kind: "owner", group }) as Entry) : [];
    return [{ kind: "overview" }, ...owners, { kind: "receipts" }];
  }

  current(state: ProducersState = this.state): Entry {
    return this.entries(state).find((e) => entryKey(e) === state.selected) ?? { kind: "overview" };
  }

  /** Producers listed on the right for the overview or an owner. */
  producers(state: ProducersState = this.state): Producer[] {
    const entry = this.current(state);
    if (entry.kind === "owner") return entry.group.producers;
    if (entry.kind === "overview" && state.doctor?.ok) return sortProducers(state.doctor.value.producers.filter((p) => p.state !== "ok"));
    return [];
  }

  /** Number of rows in the right pane. */
  rowCount(state: ProducersState = this.state): number {
    const entry = this.current(state);
    if (entry.kind === "receipts") return state.receipts?.ok ? state.receipts.value.length : 0;
    return this.producers(state).length;
  }

  private clamp() {
    const count = this.rowCount();
    const row = Math.max(0, Math.min(Math.max(0, count - 1), this.state.row));
    const selected = this.entries().some((e) => entryKey(e) === this.state.selected) ? this.state.selected : "overview";
    const pane = count === 0 ? "sidebar" : this.state.pane;
    if (row !== this.state.row || selected !== this.state.selected || pane !== this.state.pane) this.set({ row, selected, pane });
  }

  // ---- moving around ------------------------------------------------------------

  select(key: string, pane: Pane = this.state.pane) {
    if (key === this.state.selected) {
      this.setPane(pane);
      return;
    }
    this.set({ selected: key, row: 0, pane: "sidebar" });
    this.setPane(pane);
  }

  moveEntry(delta: number) {
    const keys = this.entries().map(entryKey);
    const index = Math.max(0, keys.indexOf(this.state.selected));
    this.select(keys[Math.max(0, Math.min(keys.length - 1, index + delta))], "sidebar");
  }

  setPane(pane: Pane) {
    if (pane === "list" && this.rowCount() === 0) return;
    if (pane !== this.state.pane) this.set({ pane });
  }

  moveRow(delta: number) {
    const count = this.rowCount();
    if (count === 0) return;
    const row = Math.max(0, Math.min(count - 1, this.state.row + delta));
    if (row !== this.state.row) this.set({ row });
  }

  setRow(row: number) {
    this.set({ row, pane: "list" });
  }

  setHover(hover: string | null) {
    if (hover !== this.state.hover) this.set({ hover });
  }
}
