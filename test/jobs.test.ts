import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { allocateId, DEFAULT_TIMEOUT, ID_COUNT, MAX_TIMEOUT, JobManager, parseRegistry, tailFile, type JobCompletion, type Registry } from "../src/jobs.ts";

async function workspace(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-jobs-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function waitCompletion(manager: JobManager): Promise<JobCompletion> {
  return new Promise((resolve) => {
    const off = manager.subscribe((completion) => {
      off();
      resolve(completion);
    });
  });
}

test("IDs avoid active entries and exhaustion is explicit", () => {
  const registry: Registry = {};
  assert.match(allocateId(registry, "seed"), /^[0-9a-z]{2}$/);
  for (let index = 0; index < ID_COUNT - 1; index++) {
    registry[index.toString(36).padStart(2, "0")] = { pid: 1, pgid: 1, command: "x", log_path: "x", start_time: 0, timeout: 0 };
  }
  const last = allocateId(registry, "seed");
  assert.ok(!(last in registry));
  registry[last] = { pid: 1, pgid: 1, command: "x", log_path: "x", start_time: 0, timeout: 0 };
  assert.throws(() => allocateId(registry), /1296|ID space/);
});

test("registry parsing rejects malformed data", () => {
  assert.deepEqual(parseRegistry({}), {});
  assert.throws(() => parseRegistry(null), /object/);
  assert.throws(() => parseRegistry([]), /object/);
  assert.throws(() => parseRegistry({ AB: {} }), /Invalid job ID/);
  assert.throws(() => parseRegistry({ ab: { pid: "1" } }), /Invalid registry entry/);
});

test("all new jobs require bounded positive timeouts; legacy zero values migrate to the default", async (t) => {
  const dir = await workspace(t);
  const manager = new JobManager(dir);
  t.after(() => manager.dispose());
  for (const timeout of [0, -1, 0.5, Infinity, NaN, MAX_TIMEOUT + 1]) await assert.rejects(manager.start("true", timeout), /positive integer/);
  await assert.rejects(manager.start("true", 60, undefined, " "), /title/);
  assert.deepEqual(manager.active(), []);
  const legacy = { pid: 1, pgid: 1, command: "old", log_path: "old.log", start_time: 0, timeout: 0 };
  assert.equal(parseRegistry({ aa: legacy }).aa.timeout, DEFAULT_TIMEOUT);
  for (const timeout of [-1, MAX_TIMEOUT + 1]) assert.throws(() => parseRegistry({ aa: { ...legacy, timeout } }), /Invalid registry/);
});

test("restored legacy unlimited jobs are persisted with a finite deadline and expire", { timeout: 5000 }, async (t) => {
  const dir = await workspace(t);
  const first = new JobManager(dir);
  const second = new JobManager(dir);
  t.after(() => { first.killAllSync(); first.dispose(); second.killAllSync(); second.dispose(); });
  const { id, record } = await first.start("sleep 30");
  first.dispose();
  await writeFile(first.registryPath, JSON.stringify({ [id]: { ...record, timeout: 0, start_time: Math.floor(Date.now() / 1000) - 61 } }));
  const done = waitCompletion(second);
  await second.load();
  assert.equal(second.get(id)?.timeout, DEFAULT_TIMEOUT);
  assert.equal(JSON.parse(await readFile(second.registryPath, "utf8"))[id].timeout, DEFAULT_TIMEOUT);
  assert.equal((await done).timedOut, true);
});

test("tailFile returns the last lines without loading the whole file",  async (t) => {
  const dir = await workspace(t);
  const path = join(dir, "log.txt");
  await writeFile(path, ["one", "two", "three", "four"].join("\n"));
  assert.deepEqual(await tailFile(path, 2), { text: "three\nfour", truncated: true });
  assert.deepEqual(await tailFile(path, 0), { text: "", truncated: false });
  assert.deepEqual(await tailFile(path, 10), { text: "one\ntwo\nthree\nfour", truncated: false });
});

test("long single-line tails are byte bounded", async (t) => {
  const dir = await workspace(t);
  const path = join(dir, "long.log");
  await writeFile(path, "x".repeat(1024 * 1024));
  const tail = await tailFile(path, 20);
  assert.ok(Buffer.byteLength(tail.text) <= 4096);
  assert.equal(tail.truncated, true);
});

test("tail byte limits preserve Unicode and distinguish unreadable logs from silence", async (t) => {
  const dir = await workspace(t);
  const path = join(dir, "log.txt");
  await writeFile(path, "💜".repeat(2000) + "Z");
  const unicode = await tailFile(path, 20);
  assert.ok(Buffer.byteLength(unicode.text) <= 4096);
  assert.equal(unicode.truncated, true);
  assert.ok(unicode.text.endsWith("Z"));
  assert.ok(!unicode.text.includes("\ufffd"));
  await writeFile(path, Buffer.alloc(8192, 0xff));
  assert.ok(Buffer.byteLength((await tailFile(path, 20)).text) <= 4096);
  await writeFile(path, "");
  assert.deepEqual(await tailFile(path, 20), { text: "", truncated: false });
  assert.equal((await tailFile(join(dir, "missing"), 20)).error, "ENOENT");
});

test("a job streams to disk and reports its exit through a completion event", async (t) => {
  const dir = await workspace(t);
  const manager = new JobManager(dir);
  t.after(() => { manager.killAllSync(); manager.dispose(); });
  const done = waitCompletion(manager);
  const { id, record } = await manager.start("printf 'hello\\nworld\\n'");
  assert.equal(record.pgid, record.pid);
  assert.equal(record.timeout, DEFAULT_TIMEOUT);
  const completion = await done;
  assert.equal(completion.id, id);
  assert.equal(completion.exitCode, 0);
  assert.equal(completion.timedOut, false);
  assert.deepEqual(JSON.parse(await readFile(manager.registryPath, "utf8")), {});
  assert.match(await readFile(record.log_path, "utf8"), /hello\nworld/);
  const status = await manager.check(id, 10);
  assert.equal(status.running, false);
  assert.equal(status.exitCode, 0);
  assert.equal(status.tail.text, "hello\nworld");
});

test("reused job IDs finalize failures, timeouts and successes without stale results", { timeout: 5000 }, async (t) => {
  t.mock.method(crypto, "randomBytes", (size: number) => Buffer.alloc(size));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const dir = await workspace(t);
  const manager = new JobManager(dir);
  t.after(() => { manager.killAllSync(); manager.dispose(); });
  let previousId: string | undefined;
  for (const { command, timeout, exitCode, timedOut } of [
    { command: "exit 1", timeout: 60, exitCode: 1, timedOut: false },
    { command: "sleep 30", timeout: 1, exitCode: null, timedOut: true },
    { command: "exit 0", timeout: 60, exitCode: 0, timedOut: false },
  ]) {
    const done = waitCompletion(manager);
    const { id } = await manager.start(command, timeout);
    if (previousId !== undefined) assert.equal(id, previousId);
    previousId = id;
    const completion = await done;
    assert.equal(completion.id, id);
    assert.equal(completion.exitCode, exitCode);
    assert.equal(completion.timedOut, timedOut);
    const status = await manager.check(id);
    assert.equal(status.running, false);
    assert.equal(status.exitCode, exitCode);
    assert.equal(status.timedOut, timedOut);
    assert.deepEqual(manager.active(), []);
    assert.deepEqual(JSON.parse(await readFile(manager.registryPath, "utf8")), {});
  }
});

test("running jobs accept stdin and report status with a tail", async (t) => {
  const dir = await workspace(t);
  const manager = new JobManager(dir);
  t.after(() => { manager.killAllSync(); manager.dispose(); });
  const { id } = await manager.start("cat");
  manager.send(id, "ping");
  let status = await manager.check(id, 5);
  for (let attempt = 0; attempt < 100 && !status.tail.text.includes("ping"); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    status = await manager.check(id, 5);
  }
  assert.equal(status.running, true);
  assert.match(status.tail.text, /ping/);
  const record = await manager.kill(id);
  assert.equal(record.pgid, record.pid);
  assert.equal((await manager.check(id)).running, false);
  assert.throws(() => manager.send(id, "late"), /has no attached stdin/);
});

test("timeout enforcement kills the process group and flags the completion", async (t) => {
  const dir = await workspace(t);
  const manager = new JobManager(dir);
  t.after(() => { manager.killAllSync(); manager.dispose(); });
  const done = waitCompletion(manager);
  const { id } = await manager.start("sleep 30", 1);
  const completion = await done;
  assert.equal(completion.id, id);
  assert.equal(completion.timedOut, true);
  assert.ok(completion.runtimeSeconds >= 1);
});

test("log files are capped and marked when truncated", async (t) => {
  const dir = await workspace(t);
  const manager = new JobManager(dir, { maxLogBytes: 128 });
  t.after(() => { manager.killAllSync(); manager.dispose(); });
  const done = waitCompletion(manager);
  const { record } = await manager.start("node -e \"process.stdout.write('x'.repeat(5000))\"");
  await done;
  const log = await readFile(record.log_path, "utf8");
  assert.ok(log.length <= 128 + 64, `log length ${log.length}`);
  assert.match(log, /\[log truncated at 128 bytes\]/);
});

test("a reloaded manager re-attaches to a live job and can terminate it", async (t) => {
  const dir = await workspace(t);
  const first = new JobManager(dir);
  t.after(() => { first.killAllSync(); first.dispose(); });
  const { id } = await first.start("sleep 30");
  const second = new JobManager(dir);
  t.after(() => second.dispose());
  const { restored, reaped } = await second.load();
  assert.deepEqual(restored, [id]);
  assert.deepEqual(reaped, []);
  assert.equal(second.get(id)?.pid, first.get(id)?.pid);
  const record = await second.kill(id);
  assert.equal(record.pid, first.get(id)?.pid ?? record.pid);
});

test("loading reaps entries whose processes are gone", async (t) => {
  const dir = await workspace(t);
  await writeFile(join(dir, "registry.json"), JSON.stringify({
    aa: { pid: 2147483646, pgid: 2147483646, command: "gone", log_path: join(dir, "aa.log"), start_time: 0, timeout: 0 },
  }));
  const manager = new JobManager(dir);
  t.after(() => manager.dispose());
  const { restored, reaped } = await manager.load();
  assert.deepEqual(restored, []);
  assert.deepEqual(reaped, ["aa"]);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "registry.json"), "utf8")), {});
});
