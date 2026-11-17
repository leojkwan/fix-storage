import { createRoot } from "@zenbu-labs/pixel";
import { App } from "./ui/app";
import { Store } from "./ui/store";

const args = new Set(process.argv.slice(2));
const store = new Store({ demo: args.has("--demo") });

const quit = () => {
  store.stop();
  root.stop();
};

/** Keys while the category list on the left has focus. */
function sidebarKey(key: string): boolean {
  switch (key) {
    case "up":
    case "k":
      return store.moveCategory(-1), true;
    case "down":
    case "j":
      return store.moveCategory(1), true;
    case "right":
    case "l":
    case "enter":
    case "tab":
      return store.setPane("list"), true;
  }
  return false;
}

/** Keys while the item list on the right has focus. */
function listKey(key: string): boolean {
  switch (key) {
    case "up":
    case "k":
      return store.moveRow(-1), true;
    case "down":
    case "j":
      return store.moveRow(1), true;
    case "pageup":
      return store.moveRow(-10), true;
    case "pagedown":
      return store.moveRow(10), true;
    case "home":
      return store.moveRow(-Infinity), true;
    case "end":
      return store.moveRow(Infinity), true;
    case "right":
    case "l":
    case "enter":
      return store.open(), true;
    case "left":
    case "h":
    case "escape":
      return store.back(), true;
    case "tab":
      return store.setPane("sidebar"), true;
    case "g":
      return store.goToCulprit(), true;
    case "o":
    case "space":
      return void store.reveal(), true;
  }
  return false;
}

const root = createRoot({
  name: "fix-storage",
  onKey(event) {
    if (event.kind === "release") return;
    const { key, mods } = event;
    if (mods.ctrl && key === "c") return quit(), true;
    if (mods.ctrl || mods.alt || mods.super) return;
    if (key === "q") return quit(), true;
    if (key === "r") return store.rescan(), true;
    if (key === "f") return store.toggleJunkOnly(), true;
    const handled = store.get().pane === "sidebar" ? sidebarKey(key) : listKey(key);
    return handled || undefined;
  },
  onResize() {
    render();
  },
});

function render() {
  root.render(<App root={root} store={store} />);
}

root.setTitle("fix-storage");
render();
store.rescan();
