import { basename } from "node:path";
import { CATEGORIES, type CategoryId } from "../core/categories";
import { classify, type Label, type Usage } from "../core/classify";
import {
  demoCulprit,
  demoUsage,
  findCulprit,
  forgetAllSizes,
  usage as lookUpUsage,
  type Culprit,
  demoChildren,
  listFolder,
  reveal,
  type ListHandle,
} from "../core/browse";
import { startDemoScan } from "../core/demo";
import { tilde } from "../core/format";
import { emptySnapshot, startScan, type Item, type ScanHandle, type ScanSnapshot } from "../core/scan";

/** Which side of the screen the arrow keys move in. */
export type Pane = "sidebar" | "list";

/** A folder opened inside the detail pane. */
export interface Level {
  path: string;
  size: number;
}

export interface AppState {
  scan: ScanSnapshot;
  /** Category shown in the detail pane. */
  selected: CategoryId;
  /** Category under the pointer in the bar or sidebar. */
  hover: CategoryId | null;
  pane: Pane;
  /** Highlighted row in the detail list. */
  row: number;
  /** Folders opened below the category, outermost first. */
  stack: Level[];
  /** Contents of the innermost opened folder. */
  children: Item[];
  /** True while the opened folder is still being measured. */
  listing: boolean;
  /** One line about the last action, shown until the next one. */
  note: string | null;
  /** When each listed item was last opened or changed, by path. */
  usage: Record<string, Usage>;
  /** Where the space inside each folder is, by path; "pending" while it is being measured. */
  culprits: Record<string, Culprit | "pending">;
}

export interface Options {
  demo: boolean;
}

type Listener = () => void;

/** Longest list the detail pane draws. */
export const MAX_ROWS = 150;

export class Store {
  private state: AppState = {
    scan: emptySnapshot(),
    selected: CATEGORIES[0].id,
    hover: null,
    pane: "sidebar",
    row: 0,
    stack: [],
    children: [],
    listing: false,
    note: null,
    usage: {},
    culprits: {},
  };
  private listeners = new Set<Listener>();
  private scanHandle: ScanHandle | null = null;
  private listHandle: ListHandle | null = null;
  private culpritHandle: ListHandle | null = null;
  private culpritQueue: Item[] = [];
  private usagePending = new Set<string>();
  private enrichScheduled = false;

  constructor(readonly options: Options) {}

  get = (): AppState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<AppState>) {
    const before = this.state;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
    if (
      before.selected !== this.state.selected ||
      before.stack !== this.state.stack ||
      before.children !== this.state.children ||
      before.row !== this.state.row ||
      before.scan.phase !== this.state.scan.phase
    ) {
      this.scheduleEnrich();
    }
  }

  // ---- labels, last-used dates and culprits ---------------------------------

  /** What an item probably is, and why. */
  label(item: Item, state: AppState = this.state): Label {
    return classify(item, state.selected, state.usage[item.path]);
  }

  /** Fetches dates and culprits for whatever just came on screen, once things settle. */
  private scheduleEnrich() {
    if (this.enrichScheduled) return;
    this.enrichScheduled = true;
    setTimeout(() => {
      this.enrichScheduled = false;
      this.enrich();
    }, 120);
  }

  private enrich() {
    const { scan, listing, row } = this.state;
    if (scan.phase !== "done" && this.state.stack.length === 0) return;
    const all = this.allEntries().slice(0, MAX_ROWS);

    // Last-used dates for every visible row.
    const missing = all.map((i) => i.path).filter((p) => !(p in this.state.usage) && !this.usagePending.has(p));
    if (missing.length > 0) {
      if (this.options.demo) {
        const usage = { ...this.state.usage };
        for (const p of missing) usage[p] = demoUsage(p);
        this.set({ usage });
      } else {
        for (const p of missing) this.usagePending.add(p);
        void lookUpUsage(missing).then((found) => {
          for (const p of missing) this.usagePending.delete(p);
          this.set({ usage: { ...this.state.usage, ...Object.fromEntries(found) } });
        });
      }
    }

    // Culprits: the highlighted folder first, then the biggest few on screen.
    if (listing) return;
    const entries = this.entries();
    const wanted = [entries[row], ...entries.filter((i) => i.dir).slice(0, 4)].filter(
      (i): i is Item => !!i && !!i.dir && !(i.path in this.state.culprits),
    );
    const seen = new Set<string>();
    this.culpritQueue = wanted.filter((i) => (seen.has(i.path) ? false : (seen.add(i.path), true)));
    this.nextCulprit();
  }

  private nextCulprit(): void {
    if (this.culpritHandle) return;
    const item = this.culpritQueue.shift();
    if (!item) return;
    if (item.path in this.state.culprits) return this.nextCulprit();
    this.set({ culprits: { ...this.state.culprits, [item.path]: "pending" } });
    const finish = (culprit: Culprit) => {
      this.culpritHandle = null;
      this.set({ culprits: { ...this.state.culprits, [item.path]: culprit } });
      this.nextCulprit();
    };
    if (this.options.demo) {
      const category = this.state.selected;
      const depth = this.state.stack.length + 1;
      const timer = setTimeout(() => finish(demoCulprit(category, item.path, item.size, depth)), 350);
      this.culpritHandle = { cancel: () => clearTimeout(timer) };
      return;
    }
    this.culpritHandle = findCulprit(item.path, finish);
  }

  /** Stops measuring culprits that are no longer on screen. */
  private dropCulpritWork() {
    this.culpritQueue = [];
    if (this.culpritHandle) {
      this.culpritHandle.cancel();
      this.culpritHandle = null;
      const culprits = { ...this.state.culprits };
      for (const [path, value] of Object.entries(culprits)) if (value === "pending") delete culprits[path];
      this.state = { ...this.state, culprits };
    }
  }

  /** Opens every folder on the way to the highlighted folder's culprit and lands on it. */
  goToCulprit(row = this.state.row) {
    const item = this.entries()[row];
    const culprit = item ? this.state.culprits[item.path] : undefined;
    if (!item || !culprit || culprit === "pending" || culprit.chain.length === 0) return;
    this.listHandle?.cancel();
    this.dropCulpritWork();
    const path = [item, ...culprit.chain];
    const last = path[path.length - 1];
    // Land in the folder that holds the culprit, with the culprit highlighted.
    const target = path[path.length - 2];
    const above = path.slice(0, path.length - 2).map((i) => ({ path: i.path, size: i.size }));
    this.set({ stack: [...this.state.stack, ...above] });
    this.openItem(target, last.path);
  }

  // ---- scanning ------------------------------------------------------------

  rescan() {
    this.scanHandle?.cancel();
    this.listHandle?.cancel();
    this.dropCulpritWork();
    forgetAllSizes();
    this.set({ scan: emptySnapshot(), note: null, stack: [], children: [], listing: false, row: 0, culprits: {} });
    const start = this.options.demo ? startDemoScan : startScan;
    const handle = start((scan) => {
      if (this.scanHandle === handle) this.set({ scan });
    });
    this.scanHandle = handle;
  }

  // ---- moving around -------------------------------------------------------

  setHover(hover: CategoryId | null) {
    if (hover !== this.state.hover) this.set({ hover });
  }

  /** Shows a category in the detail pane, back at its top level. */
  select(id: CategoryId, pane: Pane = this.state.pane) {
    if (id === this.state.selected && this.state.stack.length === 0) {
      if (pane !== this.state.pane) this.set({ pane });
      return;
    }
    this.listHandle?.cancel();
    this.dropCulpritWork();
    this.set({ selected: id, stack: [], children: [], listing: false, row: 0, pane });
  }

  moveCategory(delta: number) {
    const index = CATEGORIES.findIndex((c) => c.id === this.state.selected);
    const next = CATEGORIES[Math.max(0, Math.min(CATEGORIES.length - 1, index + delta))];
    this.select(next.id, "sidebar");
  }

  setPane(pane: Pane) {
    if (pane === "list" && this.entries().length === 0) return;
    if (pane !== this.state.pane) this.set({ pane });
  }

  /** What the detail pane lists right now. */
  entries(state: AppState = this.state): Item[] {
    const list = this.allEntries(state);
    return list.length > MAX_ROWS ? list.slice(0, MAX_ROWS) : list;
  }

  /** Every entry, including those past the drawing limit. */
  allEntries(state: AppState = this.state): Item[] {
    return state.stack.length === 0 ? state.scan.items[state.selected] : state.children;
  }

  /** Size of whatever the detail pane is looking at. */
  scopeSize(state: AppState = this.state): number {
    const top = state.stack[state.stack.length - 1];
    return top ? top.size : state.scan.sizes[state.selected];
  }

  moveRow(delta: number) {
    const count = this.entries().length;
    if (count === 0) return;
    const row = Math.max(0, Math.min(count - 1, this.state.row + delta));
    if (row !== this.state.row) {
      this.set({ row });
    }
  }

  setRow(row: number) {
    this.set({ row, pane: "list" });
  }

  /** Opens the highlighted folder and measures what is inside. */
  open(row = this.state.row) {
    const item = this.entries()[row];
    if (!item || !item.dir) return;
    this.listHandle?.cancel();
    this.dropCulpritWork();
    const stack = [...this.state.stack, { path: item.path, size: item.size }];

    if (this.options.demo) {
      this.set({
        stack,
        children: demoChildren(this.state.selected, item.path, item.size, stack.length),
        listing: false,
        row: 0,
        pane: "list",
        note: null,
      });
      return;
    }

    this.set({ stack, children: [], listing: true, row: 0, pane: "list", note: null });
    const handle = listFolder(item.path, (children, done) => {
      if (this.listHandle !== handle) return;
      this.set({ children, listing: !done });
    });
    this.listHandle = handle;
  }

  /** Goes up one folder; from the category's top level, back to the sidebar. */
  back() {
    const { stack } = this.state;
    if (stack.length === 0) {
      this.set({ pane: "sidebar" });
      return;
    }
    this.listHandle?.cancel();
    this.dropCulpritWork();
    const left = stack[stack.length - 1];
    const rest = stack.slice(0, -1);
    if (rest.length === 0) {
      const row = Math.max(0, this.state.scan.items[this.state.selected].findIndex((i) => i.path === left.path));
      this.set({ stack: [], children: [], listing: false, row });
      return;
    }
    // Measure the parent again and land on the folder we just left.
    const parent = rest[rest.length - 1];
    this.set({ stack: rest.slice(0, -1) });
    this.openItem({ path: parent.path, size: parent.size, dir: true }, left.path);
  }

  /** Opens a folder that is not necessarily in the current list. */
  private openItem(item: Item, highlight?: string) {
    const stack = [...this.state.stack, { path: item.path, size: item.size }];
    const pick = (children: Item[]) => Math.max(0, children.findIndex((c) => c.path === highlight));
    if (this.options.demo) {
      const children = demoChildren(this.state.selected, item.path, item.size, stack.length);
      this.set({ stack, children, listing: false, row: pick(children), pane: "list" });
      return;
    }
    this.set({ stack, children: [], listing: true, row: 0, pane: "list" });
    const handle = listFolder(item.path, (children, done) => {
      if (this.listHandle !== handle) return;
      this.set({ children, listing: !done, row: done ? pick(children) : this.state.row });
    });
    this.listHandle = handle;
  }

  /** Jumps back to a level in the breadcrumb: -1 is the category itself. */
  jump(level: number) {
    const { stack } = this.state;
    if (level >= stack.length - 1) return;
    this.listHandle?.cancel();
    this.dropCulpritWork();
    if (level < 0) {
      this.set({ stack: [], children: [], listing: false, row: 0 });
      return;
    }
    const target = stack[level];
    this.set({ stack: stack.slice(0, level) });
    this.openItem({ path: target.path, size: target.size, dir: true });
  }

  // ---- acting on items -----------------------------------------------------

  async reveal(row = this.state.row) {
    const item = this.entries()[row];
    if (!item) return;
    if (this.options.demo) {
      this.set({ note: `Demo: would show ${tilde(item.path)} in Finder.` });
      return;
    }
    try {
      await reveal(item.path);
      this.set({ note: `Showing ${basename(item.path)} in Finder.` });
    } catch {
      this.set({ note: `Could not show ${tilde(item.path)} in Finder.` });
    }
  }

  stop() {
    this.scanHandle?.cancel();
    this.listHandle?.cancel();
  }
}
