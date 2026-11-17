import { CATEGORIES, TIER_LABEL } from "./core/categories";
import { startDemoScan } from "./core/demo";
import { capacity, gb, size, tilde } from "./core/format";
import { diskCleanSource } from "./core/diskclean";
import { summaryJson, summaryText } from "./core/producers";
import { startScan, type ScanSnapshot } from "./core/scan";

/** Text and JSON output, for terminals without graphics and for scripts. Never deletes anything. */
export async function runPlain(args: string[]): Promise<void> {
  if (!args.includes("--scan")) return runProducers(args);
  return runScan(args);
}

/** The producers and receipts summary from disk-clean. Runs no du. */
async function runProducers(args: string[]): Promise<void> {
  const source = diskCleanSource(process.env, { demo: args.includes("--demo") });
  process.on("SIGINT", () => {
    source.cancel();
    process.exit(130);
  });
  const [doctor, receipts] = await Promise.all([source.doctor(), source.receipts()]);
  const summary = { doctor, receipts };
  process.stdout.write(args.includes("--json") ? summaryJson(summary) : summaryText(summary));
}

/** The folder scan summary, only under --scan: it runs du, which is slow on a nearly full disk. */
async function runScan(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const start = args.includes("--demo") ? startDemoScan : startScan;
  const live = process.stderr.isTTY === true;

  const handle = start((snapshot) => {
    if (!live || snapshot.phase === "done") return;
    const columns = process.stderr.columns ?? 80;
    const line = `Calculating ${gb(snapshot.used)}  ${tilde(snapshot.current)}`;
    process.stderr.write(`\r\x1b[2K${line.slice(0, columns - 1)}`);
  });
  process.on("SIGINT", () => {
    handle.cancel();
    if (live) process.stderr.write("\r\x1b[2K");
    process.exit(130);
  });

  const scan = await handle.done;
  if (live) process.stderr.write("\r\x1b[2K");
  process.stdout.write(json ? toJson(scan) : toText(scan));
}

function toJson(scan: ScanSnapshot): string {
  return (
    JSON.stringify(
      {
        total: scan.total,
        used: scan.used,
        available: scan.available,
        categories: CATEGORIES.map((c) => ({
          id: c.id,
          name: c.name,
          tier: c.tier,
          bytes: scan.sizes[c.id],
          largest: scan.items[c.id].slice(0, 5),
        })),
        blocked: scan.blocked,
      },
      null,
      2,
    ) + "\n"
  );
}

function toText(scan: ScanSnapshot): string {
  const lines: string[] = [];
  lines.push(`${gb(scan.used)} of ${capacity(scan.total)} used, ${gb(scan.available)} available`, "");

  const width = Math.max(...CATEGORIES.map((c) => c.name.length));
  for (const category of CATEGORIES) {
    const amount = gb(scan.sizes[category.id]).padStart(9);
    lines.push(`${category.name.padEnd(width)}  ${amount}  ${TIER_LABEL[category.tier]}`);
  }

  for (const category of CATEGORIES) {
    if (category.tier !== "safe" || scan.items[category.id].length === 0) continue;
    lines.push("", `${category.name}: ${category.blurb}`);
    for (const item of scan.items[category.id].slice(0, 5)) {
      lines.push(`  ${size(item.size).padStart(8)}  ${tilde(item.path)}`);
    }
  }

  if (scan.blocked.length > 0) {
    lines.push("", "Could not read (give your terminal Full Disk Access to include these):");
    for (const path of scan.blocked.slice(0, 8)) lines.push(`  ${tilde(path)}`);
    if (scan.blocked.length > 8) lines.push(`  and ${scan.blocked.length - 8} more`);
  }
  return lines.join("\n") + "\n";
}
