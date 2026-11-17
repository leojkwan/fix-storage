import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The viewer must not be able to change the disk. This is an allowlist, not a
// denylist: anything that touches the filesystem or starts a process has to be
// named here, so a new call fails the test until someone reads it.

const root = fileURLToPath(new URL("../", import.meta.url));

/** Files that may import the filesystem or start processes at all. */
const MAY_TOUCH_DISK = new Set(["src/core/scan.ts", "src/core/browse.ts", "src/core/diskclean.ts", "bin/fix-storage.cjs"]);

/** Filesystem calls that only read. */
const READ_ONLY_FS = new Set(["statfs", "readdir", "lstat", "stat", "readFile", "access"]);

/** Programs the viewer may start. None of them writes. */
const PROGRAMS = new Set(['"du"', '"ps"', '"mdls"', '"open"', '"bash"', "process.execPath"]);

/** bash may only run the read-only doctor, and only from the disk-clean adapter. */
const BASH_CALL = 'spawn("bash", [script, "--json"]';

const FORBIDDEN = [
  "rmSync",
  "unlink",
  "rmdir",
  "rename",
  "writeFile",
  "appendFile",
  "copyFile",
  "truncate",
  "mkdir",
  "symlink",
  "chmod",
  "chown",
  "createWriteStream",
  "/usr/bin/trash",
  "osascript",
  "to delete (POSIX",
];

const DISK_MODULE = /(?:from\s+|require\(\s*|import\(\s*)["'](?:node:)?(fs|fs\/promises|child_process)["']/g;
const FS_IMPORT = /import\s+(.+?)\s+from\s+["'](?:node:)?fs(?:\/promises)?["']/g;
const FS_CALL = /\b(?:fsp|fs|fs\.promises)\.(\w+)\s*\(/g;
const PROCESS_CALL = /(?<![.\w])(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\(\s*([^,)\s]+)/g;

async function filesIn(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesIn(path)));
    else files.push(path);
  }
  return files;
}

export function violationsIn(name, contents) {
  const found = [];
  for (const token of FORBIDDEN) if (contents.includes(token)) found.push(`${name} contains ${token}`);
  for (const match of contents.matchAll(DISK_MODULE)) {
    if (!MAY_TOUCH_DISK.has(name)) found.push(`${name} imports ${match[1]}; only ${[...MAY_TOUCH_DISK].join(", ")} may`);
  }
  for (const match of contents.matchAll(FS_IMPORT)) {
    if (match[1].replace(/\s+/g, " ") !== "{ promises as fsp }") found.push(`${name} imports ${match[1]} from fs`);
  }
  for (const match of contents.matchAll(FS_CALL)) {
    if (!READ_ONLY_FS.has(match[1])) found.push(`${name} calls fs ${match[1]}()`);
  }
  for (const match of contents.matchAll(PROCESS_CALL)) {
    if (!PROGRAMS.has(match[2])) found.push(`${name} starts ${match[2]} with ${match[1]}()`);
    if (match[2] === '"bash"' && (name !== "src/core/diskclean.ts" || !contents.startsWith(BASH_CALL, match.index)))
      found.push(`${name} starts bash for something other than the doctor`);
  }
  return found;
}

test("src and bin cannot change the disk", async () => {
  const violations = [];
  for (const directory of ["src", "bin"]) {
    for (const path of await filesIn(join(root, directory))) {
      violations.push(...violationsIn(relative(root, path), await readFile(path, "utf8")));
    }
  }
  assert.deepEqual(violations, []);
});

test("the guard catches the spellings a denylist misses", () => {
  const bad = [
    ['import { promises as fsp } from "node:fs";\nawait fsp.rm(p, { recursive: true });', "src/core/scan.ts"],
    ['import { rm } from "node:fs/promises";', "src/core/scan.ts"],
    ['import { execFile } from "node:child_process";\nexecFile("rm", ["-rf", p]);', "src/core/browse.ts"],
    ['import { spawn } from "node:child_process";\nspawn("mv", [a, b]);', "src/core/browse.ts"],
    ['const fs = await import("node:fs");', "src/ui/store.ts"],
    ['import { promises as fsp } from "node:fs";\nawait fsp.rename(a, b);', "src/core/browse.ts"],
    ['const { execSync } = require("child_process");', "src/main.tsx"],
    ['import { spawn } from "node:child_process";\nspawn("bash", ["-c", command]);', "src/core/diskclean.ts"],
    ['import { spawn } from "node:child_process";\nspawn("bash", [script, "--json"]);', "src/core/scan.ts"],
    ['spawn("bash", [script, "--json"]);\nspawn("bash", ["-c", "touch x"]);', "src/core/diskclean.ts"],
  ];
  for (const [contents, name] of bad) {
    assert.notDeepEqual(violationsIn(name, contents), [], `not caught: ${contents}`);
  }
});
