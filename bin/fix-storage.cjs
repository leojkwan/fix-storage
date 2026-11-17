#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const args = process.argv.slice(2);
const appDir = path.resolve(__dirname, "..");

const HELP = `fix-storage: see how much disk is free and which producers keep filling it.

Usage: fix-storage [options]

  (no options)   Open the Producers screen: free space against a floor and a
                 target, failing producers by owner, and past clean-up
                 receipts, read from the disk-clean tool. Needs a terminal with
                 kitty graphics (Ghostty, kitty, iTerm2, WezTerm); other
                 terminals get a simpler character view.
  --scan         Open the folder browser instead. It measures folders with du,
                 which is slow on a nearly full disk.
  --dry-run      Accepted for compatibility; has no effect.
  --demo         Use made-up data. Reads and deletes nothing.
  --plain        Print a text summary and exit. Deletes nothing.
  --json         Print the summary as JSON and exit. Deletes nothing.
  -h, --help     Show this help.

Environment:
  DISK_CLEAN_SKILL_DIR   disk-clean skill folder (default ~/.agents/skills/disk-clean)
  DISK_CLEAN_STATE_DIR   disk-clean state folder (default ~/.local/state/disk-clean)
`;

if (args.includes("-h") || args.includes("--help")) {
  process.stdout.write(HELP);
  process.exit(0);
}

const known = new Set(["--dry-run", "--demo", "--plain", "--json", "--scan"]);
const unknown = args.find((arg) => !known.has(arg));
if (unknown) {
  process.stderr.write(`fix-storage: unknown option ${unknown}\n\n${HELP}`);
  process.exit(2);
}

if (args.includes("--plain") || args.includes("--json") || !process.stdout.isTTY) {
  require(path.join(appDir, "dist", "plain.js"))
    .runPlain(args)
    .catch((error) => {
      process.stderr.write(`fix-storage: ${error && error.message ? error.message : error}\n`);
      process.exit(1);
    });
} else {
  const pixel = require.resolve("@zenbu-labs/pixel/package.json", { paths: [appDir] });
  const bin = path.join(path.dirname(pixel), "dist", "bin.js");
  const result = spawnSync(process.execPath, [bin, appDir, "--", ...args], { stdio: "inherit" });
  process.exit(result.status === null ? 1 : result.status);
}
