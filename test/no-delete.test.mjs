import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const forbidden = [
  "fs.rm",
  "fsp.rm",
  "rmSync",
  "unlink",
  "rmdir",
  "/usr/bin/trash",
  "osascript",
  'tell application "Finder" to delete',
];

async function filesIn(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesIn(path)));
    else files.push(path);
  }
  return files;
}

test("src and bin contain no file deletion paths", async () => {
  const violations = [];
  for (const directory of ["src", "bin"]) {
    for (const path of await filesIn(join(root, directory))) {
      const contents = await readFile(path, "utf8");
      for (const token of forbidden) {
        if (contents.includes(token)) violations.push(`${relative(root, path)} contains ${token}`);
      }
    }
  }
  assert.deepEqual(violations, [], "File deletion paths must not exist in the read-only viewer");
});
