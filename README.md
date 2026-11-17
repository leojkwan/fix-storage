## Read-only fork

This fork keeps the interface of [govijr/fix-storage](https://github.com/govijr/fix-storage)
as a read-only disk viewer. File deletion, moving to Trash and category clearing
have been removed so a future deletion engine can use separately audited
executors. It has no installer and no releases: run it from source. The upstream
installer would install the original app, which can delete files.

### Producers screen

The app now opens on a **Producers** screen fed by the external `disk-clean`
tool. It shows free space against a floor and a target, which producers are
failing and who owns each, and what past clean-up runs freed according to `df`.
It runs no `du` and no key cleans anything.

- Doctor: `bash $DISK_CLEAN_SKILL_DIR/scripts/producer-doctor.sh --json`
  (default `~/.agents/skills/disk-clean`). Exit 1 with valid JSON is a normal
  "something fails" reading; any other exit, unparsable output or a 60 s
  timeout shows as **unknown**, never healthy.
- Receipts: `$DISK_CLEAN_STATE_DIR/receipts/` (default
  `~/.local/state/disk-clean`). A plan receipt is shown as "plan only, not
  proof" and never counts as freed space.
- The meter's disk capacity comes from `statfs`; the doctor reports only free space.
- The folder browser below is still there behind `--scan`.

| Key | Producers screen |
| --- | --- |
| `↑` `↓` / `j` `k` | pick an owner, or move in the list |
| `→` `←` / `l` `h`, `Tab` | switch panes |
| `r` | ask the doctor again and reread receipts |
| `q` | quit |

<div align="center">

# fix-storage

**See what is filling your Mac's disk and find the culprit, from the terminal.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![macOS](https://img.shields.io/badge/platform-macOS-lightgrey)

<img width="3344" height="2160" alt="image" src="https://github.com/user-attachments/assets/bbd9ade2-e996-4e2f-9979-ff73b57738f1" />

</div>

---

## Why

"System Data: 86 GB" and a full disk warning don't tell you what to do. fix-storage measures your disk the way Finder's Storage panel does, then goes further:

- **Finds the culprit.** Under every big folder it prints where the space actually is, following the biggest subfolder down: `└ mostly in app/node_modules/  31.2 GB · 77%  junk`. Press `g` to jump straight there.
- **Labels everything.** Each item is tagged `junk`, `unused`, `system` or left as yours, with a one-line reason: *rebuilds with npm install · not touched in 7 months*, *installer · not needed once installed*, *screen capture from 3 weeks ago*.
- **Shows when you last used it.** Last-opened dates come from Spotlight, so an app you haven't opened in two years stands out.
- **Feels like a terminal tool.** One monospace font, keyboard first, mouse optional, with a live dot-matrix disk meter drawn in real pixels.

## Install

```bash
git clone https://github.com/leojkwan/fix-storage && cd fix-storage
npm install && npm start
```

**Requirements**

- macOS (Apple silicon or Intel)
- Node.js 20.11 or newer (`brew install node`)
- For the graphical view: a terminal with the kitty graphics protocol, such as [Ghostty](https://ghostty.org), [kitty](https://sw.kovidgoyal.net/kitty/), [WezTerm](https://wezfurlong.org/wezterm/) or iTerm2. Other terminals get a character-only view.

## Usage

```bash
fix-storage              # open the Producers screen (disk-clean doctor and receipts)
fix-storage --scan       # open the folder browser; measures folders with du
fix-storage --dry-run    # accepted for compatibility; has no effect
fix-storage --demo       # made-up data, to try the interface; reads and deletes nothing
fix-storage --plain      # print the producers and receipts summary and exit
fix-storage --json       # print that summary as JSON and exit
```

> [!TIP]
> Give your terminal **Full Disk Access** (System Settings → Privacy & Security → Full Disk Access) so the scan can read Mail, Messages, Safari and other protected folders. Without it, those folders are counted under *System data*.

### Keys

| Key | In the category list | In a folder |
| --- | --- | --- |
| `↑` `↓` / `j` `k` | pick a category | move |
| `→` / `Enter` | look inside | open the folder |
| `←` / `Esc` | | go up a level |
| `g` | | jump to the culprit |
| `o` / `Space` | | reveal in Finder |
| `Tab` | switch panes | switch panes |
| `r` / `q` | rescan / quit | rescan / quit |

Everything is clickable too: categories, the disk meter, rows, the breadcrumb and every action.

When something was last opened is shown as a fact in its own column; age alone never labels an item.

## How it decides

### Labels

| Label | Meaning | Examples |
| --- | --- | --- |
| `junk` | Rebuilds by itself or is a leftover. Removing it loses nothing. | `node_modules`, `.next`, `__pycache__`, Pods, Xcode DerivedData, iOS DeviceSupport, `.dmg`/`.pkg` installers, caches, the Trash |
| `unused` | Probably not needed, but your call. | build output, `.venv`, old simulators, Xcode archives, iPhone backups, archives in Downloads |
| `system` | A tool manages it; removing it by hand breaks the tool. The reason says which command to use instead. | Docker's disk image, Ollama models, Homebrew |
| *(none)* | Yours and in use. | everything else |

The rules live in [`src/core/classify.ts`](src/core/classify.ts). They are deliberately conservative; pull requests with new patterns are very welcome.

### Culprits

For a folder, fix-storage runs one `du` pass over it, then follows the biggest child down for as long as that child holds more than half of its parent. It stops at things that are one unit to you, like `node_modules`, `.app` bundles or a Photos library, and ends at a single file if one file is most of the folder. When no one thing dominates, it shows the three biggest instead. Sizes measured along the way are reused, so opening those folders afterwards is instant.

## Development

```bash
git clone https://github.com/leojkwan/fix-storage && cd fix-storage
npm install
npm run demo        # build and open the demo disk
npm run typecheck
```

The interface is React rendered by [pixel](https://www.npmjs.com/package/@zenbu-labs/pixel), which draws real pixels into terminals that support the kitty graphics protocol.

```
src/
  main.tsx          entry point and key handling
  plain.ts          --plain / --json output
  core/
    diskclean.ts    reads the disk-clean doctor and receipts
    producers.ts    what the Producers screen and text modes show
    scan.ts         measures the disk with du
    categories.ts   which folders count toward which category
    classify.ts     junk / unused / system labels and their reasons
    browse.ts       folder listing, culprits, last-used dates, reveal
    demo.ts         the made-up demo disk
  ui/
    app.tsx         the folder browser (--scan)
    producers-app.tsx  the Producers screen
    producers-store.ts its state
    bar.ts          the dot-matrix disk meter
    store.ts        app state and actions
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to propose changes and cut a release.

## License

[MIT](LICENSE)
