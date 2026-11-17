import { CATEGORIES, type CategoryId } from "./categories";
import { emptySnapshot, type Item, type ScanHandle, type ScanSnapshot } from "./scan";

/** A made-up 512 GB disk, for trying the interface without touching the real one. */
const GB = 1e9;
const TOTAL = 512 * GB;

const SIZES: Record<CategoryId, number> = {
  apps: 52.6 * GB,
  developer: 36.3 * GB,
  photos: 58.6 * GB,
  movies: 44.1 * GB,
  documents: 41.7 * GB,
  music: 12.1 * GB,
  system: 34.2 * GB,
  caches: 46.8 * GB,
  trash: 31.4 * GB,
};

const PATHS: Record<CategoryId, string[]> = {
  apps: ["/Applications/Xcode.app", "/Applications/Penrose Studio.app", "/Applications/Figma.app"],
  developer: ["~/Library/Developer/CoreSimulator", "~/.rustup/toolchains", "/opt/homebrew/Cellar"],
  photos: ["~/Pictures/Photos Library.photoslibrary"],
  movies: ["~/Movies/Final Cut Projects", "~/Movies/Screen Recordings"],
  documents: ["~/Documents/Archive", "~/Downloads/installers", "~/Desktop/old-projects"],
  music: ["~/Music/Music/Media.localized", "~/Music/Logic"],
  system: ["/System/Volumes/Data/.snapshots", "/private/var/vm", "/private/var/log"],
  caches: [
    "~/Library/Caches/pnpm",
    "~/Library/Caches/Homebrew",
    "~/Library/Developer/Xcode/DerivedData/Atlas-bfkqz",
    "~/Library/Caches/com.spotify.client",
    "~/.npm/_cacache",
    "~/Library/Caches/Google",
    "~/.cache/huggingface",
    "~/Library/Caches/com.apple.dt.Xcode",
  ],
  trash: [
    "~/.Trash/Old exports",
    "~/.Trash/atlas-backup.zip",
    "~/.Trash/Screen Recording 2025-03-02.mov",
    "~/.Trash/node_modules",
    "~/.Trash/Untitled.fcpbundle",
    "~/.Trash/Installers",
  ],
};

/** Splits a size across paths in decreasing shares. */
function split(total: number, paths: string[]): Item[] {
  const weights = paths.map((_, i) => 1 / (i + 1.4));
  const sum = weights.reduce((a, b) => a + b, 0);
  return paths.map((path, i) => ({ path, size: (total * weights[i]) / sum, dir: !/\.(zip|mov|dmg|pkg)$/i.test(path) }));
}

export function startDemoScan(onUpdate: (snapshot: ScanSnapshot) => void): ScanHandle {
  const snap = emptySnapshot();
  snap.total = TOTAL;
  let timer: NodeJS.Timeout | null = null;

  const done = new Promise<ScanSnapshot>((resolve) => {
    const steps = CATEGORIES.flatMap((category) => {
      if (category.id === "system") return [];
      const parts = 14;
      return Array.from({ length: parts }, (_, i) => ({
        id: category.id,
        bytes: SIZES[category.id] / parts,
        path: PATHS[category.id][i % PATHS[category.id].length],
      }));
    });
    let index = 0;
    timer = setInterval(() => {
      const step = steps[index++];
      if (step) {
        snap.sizes[step.id] += step.bytes;
        snap.used += step.bytes;
        snap.current = step.path;
        onUpdate({ ...snap, sizes: { ...snap.sizes } });
        return;
      }
      if (timer) clearInterval(timer);
      snap.sizes = { ...SIZES };
      snap.used = Object.values(SIZES).reduce((a, b) => a + b, 0);
      snap.available = TOTAL - snap.used;
      for (const category of CATEGORIES) snap.items[category.id] = split(SIZES[category.id], PATHS[category.id]);
      snap.current = "";
      snap.phase = "done";
      onUpdate({ ...snap, sizes: { ...snap.sizes } });
      resolve(snap);
    }, 35);
  });

  return {
    cancel() {
      if (timer) clearInterval(timer);
    },
    done,
  };
}
