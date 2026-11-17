import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Runs against the build output: `npm run build` first, as CI does.
const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const dc = await import(new URL("../dist/core/diskclean.js", import.meta.url));
const view = await import(new URL("../dist/core/producers.js", import.meta.url));

const source = (skill, options = {}) =>
  dc.diskCleanSource(
    { DISK_CLEAN_SKILL_DIR: fixtures + skill, DISK_CLEAN_STATE_DIR: fixtures + "state" },
    { timeoutMs: 5000, ...options },
  );

test("a doctor that exits 1 with valid JSON is a valid, unhealthy reading", async () => {
  const result = await source("skill-fail").doctor();
  assert.equal(result.ok, true, result.reason);
  const doctor = result.value;
  assert.equal(doctor.healthy, false);
  assert.equal(doctor.failing, 2);
  assert.equal(doctor.free.gib, 42.5);
  assert.equal(doctor.producers.length, 5);

  const groups = view.groupByOwner(doctor);
  assert.deepEqual(
    groups.map((g) => [g.owner, g.failing]),
    [["Team A", 1], ["Team B", 1]],
  );
  assert.equal(groups.reduce((sum, g) => sum + g.failing, 0), doctor.failing, "owner counts sum to the doctor's");
  assert.deepEqual(
    groups[0].producers.map((p) => p.state),
    ["fail", "gap", "ok"],
    "failing first, then gaps",
  );
});

test("exit 2, garbage and a timeout are unknown, never healthy", async () => {
  const exit2 = await source("skill-exit2").doctor();
  assert.equal(exit2.ok, false);
  assert.match(exit2.reason, /exited 2/);

  const garbage = await source("skill-garbage").doctor();
  assert.equal(garbage.ok, false);
  assert.match(garbage.reason, /not JSON/);

  const started = Date.now();
  const hang = await source("skill-hang", { timeoutMs: 300 }).doctor();
  assert.equal(hang.ok, false);
  assert.match(hang.reason, /timed out/);
  assert.ok(Date.now() - started < 3000, "resolves on its own timer, not when the child exits");

  const missing = await source("no-such-skill").doctor();
  assert.equal(missing.ok, false);
});

test("parseDoctor rejects a signal, a wrong schema and a missing free reading", () => {
  const good = readFileSync(fixtures + "doctor-fail.json", "utf8");
  assert.equal(dc.parseDoctor(good, 0).ok, true);
  assert.equal(dc.parseDoctor(good, 1).ok, true);
  assert.equal(dc.parseDoctor(good, null).ok, false);
  assert.equal(dc.parseDoctor(good, 3).ok, false);
  assert.equal(dc.parseDoctor(JSON.stringify({ ...JSON.parse(good), schema: "other/1" }), 0).ok, false);
  assert.equal(dc.parseDoctor(JSON.stringify({ ...JSON.parse(good), free: {} }), 0).ok, false);
  // "healthy: true" with a failing producer is not healthy.
  const lying = dc.parseDoctor(JSON.stringify({ ...JSON.parse(good), healthy: true }), 0);
  assert.equal(lying.ok && lying.value.healthy, false);
});

test("a plan receipt never contributes freed bytes", async () => {
  const result = await source("skill-fail").receipts();
  assert.equal(result.ok, true);
  const plans = result.value.filter((r) => r.mode === "plan");
  assert.equal(plans.length, 1);
  assert.equal(plans[0].freedBytes, null, "the plan fixture carries +5 GB of df delta, which must be ignored");
  assert.equal(view.freedText(plans[0]), "plan only, not proof");
  assert.deepEqual(plans[0].counts, { "would-remove": 2 });

  const reap = result.value.find((r) => r.tool === "build-output-reap" && r.mode === "execute" && r.state === "complete");
  assert.equal(reap.freedBytes, 2_000_000_000);
  assert.deepEqual(reap.counts, { removed: 2, "kept-busy": 1 });

  const refused = result.value.find((r) => r.refusal);
  assert.equal(refused.state, "lock-timeout");
  assert.equal(refused.freedBytes, null, "a refused run claims no df change, in either direction");

  // One finished reap and one finished worktree run; the plan and the refused run add nothing.
  assert.equal(dc.freedTotal(result.value), 2_000_000_000 + 1_500_000_000);

  const json = JSON.parse(view.summaryJson({ doctor: { ok: false, reason: "x" }, receipts: result }));
  for (const r of json.receipts) if (r.mode === "plan") assert.equal(r.freed_df_bytes, null);
});

test("worktree receipt TSV: last result per path, TOTAL row gives the df total", () => {
  const done = dc.parseWorktreeReceipt("worktree-execute-0001", readFileSync(fixtures + "state/receipts/worktree-execute-0001/receipt.tsv", "utf8"));
  assert.equal(done.mode, "execute");
  assert.equal(done.state, "done");
  assert.equal(done.freedBytes, 1_500_000_000);
  assert.deepEqual(done.counts, { removed: 2, skip: 1 });
  assert.equal(done.at, 1767268805000);

  const unfinished = dc.parseWorktreeReceipt("worktree-execute-0002", readFileSync(fixtures + "state/receipts/worktree-execute-0002/receipt.tsv", "utf8"));
  assert.equal(unfinished.state, "incomplete");
  assert.equal(unfinished.freedBytes, null, "no TOTAL row, no freed claim");
  assert.deepEqual(unfinished.counts, { removing: 1 });
});

test("receipts come newest first", async () => {
  const result = await source("skill-fail").receipts();
  const times = result.value.map((r) => r.at);
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});

test("--demo --json prints valid JSON with producers and receipts", () => {
  const out = execFileSync(process.execPath, [root + "bin/fix-storage.cjs", "--demo", "--json"], { encoding: "utf8" });
  const json = JSON.parse(out);
  assert.ok(Array.isArray(json.producers) && json.producers.length > 0);
  assert.ok(json.producers.every((p) => typeof p.owner === "string" && typeof p.state === "string"));
  assert.ok(Array.isArray(json.receipts) && json.receipts.length > 0);
  assert.equal(json.doctor.state, "unhealthy");
});

test("--demo --plain runs no du and shows the totals line", () => {
  const out = execFileSync(process.execPath, [root + "bin/fix-storage.cjs", "--demo", "--plain"], { encoding: "utf8" });
  assert.match(out, /GiB free · floor \d+ · target \d+ · gap /);
  assert.match(out, /plan only, not proof/);
  assert.doesNotMatch(out, /Calculating/);
});

test("a refused or unfinished execute receipt never claims freed bytes", () => {
  const refused = dc.parseReapReceipt(
    "build-output-reap-x-execute.json",
    JSON.stringify({ mode: "execute", state: "lock-timeout", refusal: "busy", free_start_bytes: 1, free_end_bytes: 1001, items: [] }),
  );
  assert.equal(refused.freedBytes, null);
  const unfinished = dc.parseReapReceipt(
    "build-output-reap-y-execute.json",
    JSON.stringify({ mode: "execute", state: "incomplete", free_start_bytes: 1, free_end_bytes: 1001, items: [] }),
  );
  assert.equal(unfinished.freedBytes, null);
  const tsv = dc.parseWorktreeReceipt("worktree-execute-z", "time\tpath\tresult\tdetail\tdf_delta_bytes\n1\tTOTAL\tINCOMPLETE\tx\t100\n");
  assert.equal(tsv.freedBytes, null);
});

test("a doctor whose totals contradict its rows, or with a bad row, is never healthy", () => {
  const base = { schema: "disk-clean.doctor/1", measured_at: "2026-01-01T00:00:00Z", free: { gib: 10, floor_gib: 5, target_gib: 20 } };
  const lying = dc.parseDoctor(JSON.stringify({ ...base, producers: [{ id: "a", state: "fail" }], failing: 0, unknown: 0, healthy: true }), 0);
  assert.equal(lying.ok, true);
  assert.equal(lying.value.healthy, false);
  assert.equal(lying.value.failing, 1);
  assert.equal(dc.parseDoctor(JSON.stringify({ ...base, producers: [null], healthy: true }), 0).ok, false);
  assert.equal(dc.parseDoctor(JSON.stringify({ ...base, free: { gib: -1, floor_gib: 5, target_gib: 20 }, producers: [], healthy: true }), 0).ok, false);
});
