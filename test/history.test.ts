import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { restoreCompletions } from "../src/history.ts";

const completion = (id: string) => ({ id, record: { pid: 1, pgid: 1, command: "true", log_path: `/tmp/${id}.log`, start_time: 1, timeout: 60 }, exitCode: 0, signal: null, timedOut: false, runtimeSeconds: 1 });

test("history reads real Pi custom-message entries and only the current branch", () => {
  const session = SessionManager.inMemory("/tmp");
  const first = session.appendCustomMessageEntry("async-jobs-completion", "Finished", true, { jobs: [{ completion: completion("ab"), tail: { text: "Original output", truncated: false } }] });
  session.appendCustomMessageEntry("async-jobs-completion", "Finished", true, { jobs: [{ completion: completion("cd") }] });
  assert.deepEqual(restoreCompletions(session.getBranch()).map((job) => job.id), ["ab", "cd"]);
  assert.equal(restoreCompletions(session.getBranch())[0].tail?.text, "Original output");
  session.branch(first);
  session.appendCustomEntry("unrelated", {});
  session.appendCustomMessageEntry("async-jobs-completion", "Corrupt metadata", true, { jobs: [{ completion: {} }] });
  assert.deepEqual(restoreCompletions(session.getBranch()).map((job) => job.id), ["ab"]);
});
