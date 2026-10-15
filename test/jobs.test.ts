import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { allocateId, ID_COUNT, JobManager, parseRegistry, tailFile, type JobCompletion, type Registry } from "../src/jobs.ts";

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

test("tailFile returns the last lines without loading the whole file", async (t) => {
  const dir = await workspace(t);
  const path = join(dir, "log.txt");
  await writeFile(path, ["one", "two", "three", "four"].join("\n"));
  assert.equal(await tailFile(path, 2), "three\nfour");
  assert.equal(await tailFile(path, 0), "");
  assert.equal(await tailFile(path, 10), "one\ntwo\nthree\nfour");
});

test("a job streams to disk and reports its exit through a completion event", async (t) => {
  const dir = await workspace(t);
  const manager = new JobManager(dir);
  t.after(() => { manager.killAllSync(); manager.dispose(); });
  const done = waitCompletion(manager);
  const { id, record } = await manager.start("printf 'hello\\nworld\\n'");
  assert.equal(record.pgid, record.pid);
  const completion = await done;
  assert.equal(completion.id, id);
  assert.equal(completion.exitCode, 0);
  assert.equal(completion.timedOut, false);
  assert.match(await readFile(record.log_path, "utf8"), /hello\nworld/);
  const status = await manager.check(id, 10);
  assert.equal(status.running, false);
  assert.equal(status.exitCode, 0);
  assert.equal(status.tail, "hello\nworld");
});

test("running jobs accept stdin and report status with a tail", async (t) => {
  const dir = await workspace(t);
  const manager = new JobManager(dir);
  t.after(() => { manager.killAllSync(); manager.dispose(); });
  const { id } = await manager.start("cat");
  manager.send(id, "ping");
  let status = await manager.check(id, 5);
  for (let attempt = 0; attempt < 100 && !status.tail.includes("ping"); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    status = await manager.check(id, 5);
  }
  assert.equal(status.running, true);
  assert.match(status.tail, /ping/);
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
