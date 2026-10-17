import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCompletions, formatJobLine, formatStatus, jobOutcome, MAX_COMPLETION_BYTES, type CompletionFeedback } from "../src/format.ts";
import type { JobCompletion } from "../src/jobs.ts";

const completion: JobCompletion = {
  id: "ab", record: { pid: 123, pgid: 123, command: "npm test", log_path: "/tmp/jobs/ab.log", start_time: 0, timeout: 60 },
  exitCode: 0, signal: null, timedOut: false, runtimeSeconds: 14,
};

test("feedback distinguishes success, failure, timeout, signals, unknown exits and missing output", () => {
  assert.equal(formatCompletions([{ completion, tail: { text: "17 tests passed.", truncated: false } }]), "Job [ab] succeeded (14s): npm test\nOutput [ab]:\n17 tests passed.");
  for (const [changes, expected] of [
    [{ exitCode: 2 }, /failed \(exit 2\)/],
    [{ exitCode: null, timedOut: true }, /timed out after 60s/],
    [{ exitCode: null, signal: "SIGINT" }, /terminated \(SIGINT\)/],
    [{ exitCode: null }, /finished \(exit unknown\)/],
  ] as const) {
    const job = { ...completion, ...changes };
    const text = formatCompletions([{ completion: job, tail: { text: "", truncated: false } }]);
    assert.match(text, expected);
    assert.match(text, /Logs:/);
    assert.match(formatStatus({ ...job, running: false, tail: { text: "", truncated: false } }), expected);
  }
  const missing = formatCompletions([{ completion, tail: { text: "", truncated: false, error: "ENOENT" } }]);
  assert.match(missing, /Output \[ab\] unavailable \(ENOENT\)/);
  assert.ok(missing.includes(completion.record.log_path));
  const customLog = "/tmp/jobs/custom-output.log";
  const custom = formatCompletions([{ completion: { ...completion, record: { ...completion.record, log_path: customLog } }, tail: { text: "", truncated: true } }]);
  assert.ok(custom.includes(customLog));
  assert.equal(formatStatus({ ...completion, running: true, exitCode: null, tail: { text: "", truncated: false } }), "Job [ab] running (14s): npm test");
});

test("batched notifications bound output without burying later job statuses", () => {
  const jobs: CompletionFeedback[] = Array.from({ length: 20 }, (_, i) => ({
    completion: { ...completion, id: i.toString(36).padStart(2, "0"), exitCode: i === 19 ? 1 : 0, record: { ...completion.record, log_path: `/tmp/jobs/${i.toString(36).padStart(2, "0")}.log` } },
    tail: { text: "x".repeat(4096), truncated: false },
  }));
  const text = formatCompletions(jobs);
  assert.ok(Buffer.byteLength(text) <= MAX_COMPLETION_BYTES);
  assert.match(text, /20 jobs finished \(1 unsuccessful, 0 unknown\)/);
  for (const { completion: job } of jobs) assert.ok(text.includes(`Job [${job.id}]`));
  assert.match(text, /Job \[0j\] failed \(exit 1\)/);
  assert.match(text, /Completion details truncated/);
  assert.match(text, /Logs:/);
});

test("widget rows stay single-line and keep compact durations ahead of long commands", () => {
  const command = "echo one\necho two\r\t\x1b[2A\x1b[31m💜\x1b[0m\x07";
  for (const [seconds, duration] of [[0, "0s"], [59, "59s"], [60, "1:00"], [3599, "59:59"], [3600, "1:00:00"]] as const) {
    const row = formatJobLine("ab", command, true, seconds);
    assert.equal(row, `▶ [ab] ${duration} echo one echo two 💜`);
    assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(row));
  }
});

test("finished job rows use distinct outcome markers", () => {
  for (const [outcome, marker] of [
    [jobOutcome({ exitCode: 0 }), "✓"],
    [jobOutcome({ exitCode: 1 }), "✗"],
    [jobOutcome({ exitCode: null, timedOut: true }), "⏱"],
    [jobOutcome({ exitCode: null, signal: "SIGINT" }), "⚠"],
    [jobOutcome({ exitCode: null }), "?"],
    [jobOutcome({ running: true }), "▶"],
  ] as const) {
    assert.equal(formatJobLine("ab", "npm test", outcome === "running", 14, outcome), `${marker} [ab] 14s npm test`);
  }
});

test("large command labels and batches remain bounded and valid Unicode", () => {
  const jobs = Array.from({ length: 200 }, (_, i) => ({
    completion: { ...completion, id: i.toString(36).padStart(2, "0"), record: { ...completion.record, command: "💜".repeat(1000) + "\nEND", log_path: `/tmp/jobs/${i.toString(36).padStart(2, "0")}.log` } },
    tail: { text: "", truncated: false },
  }));
  const text = formatCompletions(jobs);
  assert.ok(Buffer.byteLength(text) <= MAX_COMPLETION_BYTES);
  assert.ok(text.isWellFormed());
  assert.match(text, /Completion details truncated/);
  assert.ok(!text.includes("END"));
  assert.equal(formatCompletions([]), "");
});
