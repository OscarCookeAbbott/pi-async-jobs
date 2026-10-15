import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import extension from "../src/index.ts";

type Details = { id: string; logPath: string };

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function harness(dir: string) {
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const tools = new Map<string, ToolDefinition<TSchema, Details>>();
  const messages: Array<{ message: any; options: any }> = [];
  const notifications: string[] = [];
  const widgets = new Map<string, any>();
  let command: any;
  let idle = true;
  const ctx = {
    mode: "tui",
    cwd: dir,
    isIdle: () => idle,
    sessionManager: { getBranch: () => [] },
    ui: {
      setWidget: (key: string, content: unknown) => widgets.set(key, content),
      notify: (text: string) => notifications.push(text),
    },
  } as unknown as ExtensionContext;
  extension({
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerTool: (definition: ToolDefinition<TSchema, Details>) => tools.set(definition.name, definition),
    registerCommand: (_name: string, definition: any) => { command = definition; },
    getSettings: () => ({}),
    sendMessage: (message: any, options: any) => messages.push({ message, options }),
  } as unknown as ExtensionAPI);
  const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
  return {
    dir, tools, messages, notifications, widgets, ctx, emit,
    get command() { return command; },
    setIdle(value: boolean) { idle = value; },
    async call(name: string, params: JsonObject) {
      const tool = tools.get(name)!;
      const validated = validateToolArguments(tool, { type: "toolCall", id: "call", name, arguments: params });
      return tool.execute("call", validated, undefined, undefined, ctx as any);
    },
    text(result: { content: Array<{ type: string; text?: string }> }): string {
      return result.content.flatMap((item) => item.type === "text" ? [item.text ?? ""] : []).join("\n");
    },
    widgetLines(width = 80): string[] {
      const factory = widgets.get("async-jobs");
      return factory ? factory({}, { fg: (_color: string, text: string) => text }).render(width) : [];
    },
  };
}

async function setup(t: TestContext, options: { corrupt?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-jobs-ext-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  if (options.corrupt) await writeFile(join(dir, "registry.json"), "not json");
  process.env.PI_JOBS_DIR = dir;
  const h = harness(dir);
  t.after(() => { h.emit("session_shutdown"); delete process.env.PI_JOBS_DIR; });
  await h.emit("session_start");
  return h;
}

test("registers the four background tools and validates their arguments", async (t) => {
  const h = await setup(t);
  assert.deepEqual([...h.tools.keys()].sort(), ["bash_async", "bash_check", "bash_kill", "bash_send"]);
  assert.equal(h.tools.get("bash_async")!.executionMode, "sequential");
  await assert.rejects(h.call("bash_async", { command: "" }), /validation|minimum/i);
  await assert.rejects(h.call("bash_check", { id: "!!" }), /validation|pattern/i);
  await assert.rejects(h.call("bash_check", { id: "zz" }), /Unknown job/);
});

test("a finished job produces one merged completion frame and triggers a turn when idle", async (t) => {
  const h = await setup(t);
  h.setIdle(true);
  const started = await h.call("bash_async", { command: "printf 'hi\\n'" });
  const { id } = started.details!;
  await waitUntil(() => h.messages.length === 1);
  assert.equal(h.messages[0].message.customType, "async-jobs-completion");
  assert.equal(h.messages[0].options.triggerTurn, true);
  assert.match(h.messages[0].message.content, /\[Background Job [0-9a-z]{2} finished with exit code 0/);
  assert.match(h.messages[0].message.content, /printf/);
  assert.match(h.messages[0].message.content, /hi/);
  assert.ok(h.messages[0].message.content.includes(id));
  assert.deepEqual(h.widgetLines(), []);
});

test("completions from concurrent jobs are collapsed and steer an active run", async (t) => {
  process.env.PI_JOBS_DEBOUNCE_MS = "500";
  t.after(() => delete process.env.PI_JOBS_DEBOUNCE_MS);
  const h = await setup(t);
  h.setIdle(false);
  const first = await h.call("bash_async", { command: "printf 'one\\n'" });
  const second = await h.call("bash_async", { command: "printf 'two\\n'" });
  await waitUntil(() => h.messages.length > 0);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].options.deliverAs, "steer");
  assert.ok(h.messages[0].message.content.includes(first.details!.id));
  assert.ok(h.messages[0].message.content.includes(second.details!.id));
});

test("running jobs appear in the widget and can be inspected, fed, and killed", async (t) => {
  const h = await setup(t);
  const started = await h.call("bash_async", { command: "cat", timeout: 0 });
  const { id } = started.details!;
  await waitUntil(() => h.widgetLines().length > 0);
  assert.ok(h.widgetLines().some((line) => line.includes(id)));
  assert.ok(h.widgetLines().every((line) => visibleWidth(line) <= 80));
  const running = h.text(await h.call("bash_check", { id }));
  assert.match(running, /running/);
  assert.match(h.text(await h.call("bash_send", { id, input: "ping" })), /Input sent/);
  let tail = h.text(await h.call("bash_check", { id, tail_lines: 5 }));
  for (let attempt = 0; attempt < 100 && !tail.includes("ping"); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    tail = h.text(await h.call("bash_check", { id, tail_lines: 5 }));
  }
  assert.match(tail, /ping/);
  await h.command.handler("", h.ctx);
  assert.ok(h.notifications.at(-1)!.includes(id));
  assert.match(h.text(await h.call("bash_kill", { id })), new RegExp(`Job ${id} \\(PGID \\d+\\) terminated\\.`));
  assert.deepEqual(h.widgetLines(), []);
});

test("a corrupt registry fails closed instead of overwriting durable state", async (t) => {
  const h = await setup(t, { corrupt: true });
  await assert.rejects(h.call("bash_async", { command: "echo hi" }), /unavailable/);
  assert.ok(h.notifications.some((note) => /failed to load/.test(note)));
});
