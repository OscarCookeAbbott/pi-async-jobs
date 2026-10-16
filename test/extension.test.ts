import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function harness(dir: string, settings: Record<string, unknown> = {}) {
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const tools = new Map<string, ToolDefinition<TSchema, Details>>();
  const messages: Array<{ message: any; options: any }> = [];
  const renderers = new Map<string, Function>();
  const notifications: string[] = [];
  const widgets = new Map<string, any>();
  let command: any;
  let idle = true;
  let renderRequests = 0;
  let widgetUpdates = 0;
  const ctx = {
    mode: "tui",
    cwd: dir,
    isIdle: () => idle,
    sessionManager: { getBranch: () => [] },
    ui: {
      setWidget: (key: string, content: unknown) => { widgetUpdates++; widgets.set(key, content); },
      notify: (text: string) => notifications.push(text),
    },
  } as unknown as ExtensionContext;
  extension({
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerTool: (definition: ToolDefinition<TSchema, Details>) => tools.set(definition.name, definition),
    registerCommand: (_name: string, definition: any) => { command = definition; },
    registerMessageRenderer: (name: string, renderer: Function) => renderers.set(name, renderer),
    getSettings: () => settings,
    sendMessage: (message: any, options: any) => messages.push({ message, options }),
  } as unknown as ExtensionAPI);
  const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
  return {
    dir, tools, messages, renderers, notifications, widgets, ctx, emit,
    get command() { return command; },
    get renderRequests() { return renderRequests; },
    get widgetUpdates() { return widgetUpdates; },
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
      return factory ? factory({ requestRender: () => { renderRequests++; } }, { fg: (_color: string, text: string) => text }).render(width) : [];
    },
  };
}

async function setup(t: TestContext, options: { corrupt?: boolean; configure?: (dir: string) => Promise<Record<string, unknown>> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-jobs-ext-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  if (options.corrupt) await writeFile(join(dir, "registry.json"), "not json");
  const settings = options.configure ? await options.configure(dir) : {};
  process.env.PI_JOBS_DIR = dir;
  const h = harness(dir, settings);
  t.after(() => { h.emit("session_shutdown"); delete process.env.PI_JOBS_DIR; });
  await h.emit("session_start");
  return h;
}

test("registers the four background tools and validates their arguments", async (t) => {
  const h = await setup(t);
  assert.deepEqual([...h.tools.keys()].sort(), ["bash_async", "bash_check", "bash_kill", "bash_send"]);
  const tool = h.tools.get("bash_async")!;
  assert.equal(tool.executionMode, "sequential");
  assert.equal(tool.promptSnippet, "Run lengthy commands without blocking the agent, with automatic completion notifications.");
  assert.ok(tool.description.startsWith(tool.promptSnippet!));
  assert.match(tool.promptGuidelines!.join("\n"), /reserve bash for quick commands/);
  assert.match(tool.promptGuidelines!.join("\n"), /continue independent work or end your turn/);
  await assert.rejects(h.call("bash_async", { command: "" }), /validation|minimum/i);
  await assert.rejects(h.call("bash_check", { id: "!!" }), /validation|pattern/i);
  await assert.rejects(h.call("bash_check", { id: "zz" }), /Unknown job/);
});

test("async call headers use the built-in shell style and show the effective timeout", () => {
  const h = harness("/unused");
  const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => `<bold>${text}</bold>` };
  const render = h.tools.get("bash_async")!.renderCall! as Function;
  for (const [timeout, suffix] of [[undefined, "timeout 60s"], [120, "timeout 120s"], [0, "no timeout"]] as const) {
    const text = render({ command: "echo hi", timeout }, theme, {}).render(200).join("\n").trimEnd();
    assert.equal(text, `<toolTitle><bold>$ echo hi</bold></toolTitle><muted> (${suffix}) [async]</muted>`);
  }
  for (const name of ["bash_check", "bash_send", "bash_kill"]) {
    const renderCall = h.tools.get(name)!.renderCall! as Function;
    assert.equal(renderCall({ id: "ab" }, theme, {}).render(200).join("\n").trimEnd(), `<toolTitle><bold>${name}</bold></toolTitle><accent><bold> [ab]</bold></accent>`);
    assert.equal(renderCall({}, theme, {}).render(200).join("\n").trimEnd(), `<toolTitle><bold>${name}</bold></toolTitle><muted> ...</muted>`);
  }
  const styles: string[] = [];
  const resultTheme = { fg: (color: string, text: string) => { styles.push(color); return text; } };
  const result = { content: [{ type: "text", text: "output" }], details: {} };
  const renderResult = h.tools.get("bash_async")!.renderResult! as Function;
  renderResult(result, { expanded: false }, resultTheme, { isError: false });
  renderResult(result, { expanded: false }, resultTheme, { isError: true });
  assert.deepEqual(styles, ["toolOutput", "error"]);
});

test("completion notifications retain themed backgrounds and configured padding", () => {
  const h = harness("/unused");
  for (const outputPad of [0, 2]) {
    const backgrounds: string[] = [];
    const foregrounds: string[] = [];
    const theme = {
      fg: (color: string, text: string) => { foregrounds.push(color); return text; },
      bg: (color: string, text: string) => { backgrounds.push(color); return text; },
      bold: (text: string) => { assert.equal(text, "Job [ab] succeeded."); return text; },
    };
    const lines: string[] = h.renderers.get("async-jobs-completion")!({ content: "Job [ab] succeeded." }, { expanded: false, outputPad }, theme).render(80);
    assert.ok(lines.includes(" ".repeat(outputPad) + "Job [ab] succeeded." + " ".repeat(80 - outputPad - "Job [ab] succeeded.".length)));
    assert.ok(backgrounds.length > 0 && backgrounds.every((color) => color === "customMessageBg"));
    assert.deepEqual(foregrounds, ["toolTitle"]);
    assert.ok(lines.every((line) => visibleWidth(line) <= 80));
  }
});

test("batched notifications emphasise status headers without styling log text as headers", () => {
  const h = harness("/unused");
  const content = "2 jobs finished (1 unsuccessful, 0 unknown).\nJob [ab] succeeded.\nJob [cd] failed.\nOutput [ab]:\nJob [zz] succeeded.";
  const headings: string[] = [];
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => { headings.push(text); return text; },
  };
  const rendered = h.renderers.get("async-jobs-completion")!({ content }, { expanded: false, outputPad: 0 }, theme).render(200);
  assert.equal(rendered.map((line: string) => line.trim()).filter(Boolean).join("\n"), content);
  assert.deepEqual(headings, content.split("\n").slice(0, 3));
});

test("job outputs collapse by visual lines and expand without changing model content", () => {
  const h = harness("/unused");
  const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
  for (const body of [Array.from({ length: 25 }, (_, index) => `line ${index}`).join("\n"), "x".repeat(1000)]) {
    const content = `Job [ab] succeeded.\nOutput [ab]:\nSTART\n${body}\nFINISH`;
    const result = { content: [{ type: "text", text: content }], details: {} };
    const render = h.tools.get("bash_check")!.renderResult! as Function;
    const collapsed: string[] = render(result, { expanded: false }, theme, {}).render(40);
    const expanded: string[] = render(result, { expanded: true }, theme, {}).render(40);
    assert.ok(collapsed.length <= 7);
    assert.match(collapsed.join("\n"), /Job \[ab\] succeeded/);
    assert.match(collapsed.join("\n"), /expand/);
    assert.match(collapsed.join("\n"), /FINISH/);
    assert.doesNotMatch(collapsed.join("\n"), /START/);
    assert.match(expanded.join("\n"), /START/);
    assert.ok(expanded.length > collapsed.length);
    const message = { content };
    const renderer = h.renderers.get("async-jobs-completion")!;
    const notification: string[] = renderer(message, { expanded: false, outputPad: 0 }, theme).render(40);
    assert.ok(notification.length <= 9);
    assert.match(notification.join("\n"), /expand/);
    assert.doesNotMatch(notification.join("\n"), /START/);
    assert.match(renderer(message, { expanded: true, outputPad: 0 }, theme).render(40).join("\n"), /START/);
    assert.ok([...collapsed, ...notification].every((line) => visibleWidth(line) <= 40));
    assert.equal(result.content[0].text, content);
    assert.equal(message.content, content);
  }
});

test("a finished job produces one merged completion frame and triggers a turn when idle", async (t) => {
  const h = await setup(t);
  h.setIdle(true);
  const started = await h.call("bash_async", { command: "printf 'hi\\n'" });
  const { id } = started.details!;
  await waitUntil(() => h.messages.length === 1);
  assert.equal(h.messages[0].message.customType, "async-jobs-completion");
  assert.equal(h.messages[0].options.triggerTurn, true);
  assert.match(h.messages[0].message.content, /Job \[[0-9a-z]{2}\] succeeded/);
  assert.equal(h.text(started), `Job [${id}] started in background. Continue independent work, or end your turn; completion will notify you automatically.`);
  assert.doesNotMatch(h.messages[0].message.content, /PID|PGID|Log[s]?:/);
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
  assert.equal(h.text(await h.call("bash_kill", { id })), `Job [${id}] terminated.`);
  assert.deepEqual(h.widgetLines(), []);
});

test("running durations redraw once per second without rebuilding widgets or messaging the agent", async (t) => {
  const h = await setup(t);
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  const started = await h.call("bash_async", { command: "cat\n# " + "💜".repeat(80) + "\t\r", timeout: 0 });
  const { id } = started.details!;
  const factory = h.widgets.get("async-jobs");
  assert.match(h.widgetLines(24)[1], /0s/);
  const updates = h.widgetUpdates;
  t.mock.timers.tick(999);
  assert.equal(h.renderRequests, 0);
  t.mock.timers.tick(1);
  assert.equal(h.renderRequests, 1);
  assert.match(h.widgetLines(24)[1], /1s/);
  t.mock.timers.tick(59000);
  assert.match(h.widgetLines(24)[1], /1:00/);
  assert.equal(h.widgets.get("async-jobs"), factory);
  assert.equal(h.widgetUpdates, updates);
  assert.equal(h.messages.length, 0);
  for (const width of [1, 12, 24, 80]) {
    assert.ok(h.widgetLines(width).every((line) => !/[\r\n\t]/.test(line) && visibleWidth(line) <= width));
  }
  await h.call("bash_kill", { id });
  const requests = h.renderRequests;
  t.mock.timers.tick(1000);
  assert.equal(h.renderRequests, requests);
  assert.deepEqual(h.widgetLines(), []);
});

test("non-interactive jobs do not start UI refreshes", async (t) => {
  const h = await setup(t);
  Reflect.set(h.ctx, "mode", "print");
  t.mock.timers.enable({ apis: ["setInterval"] });
  const started = await h.call("bash_async", { command: "cat", timeout: 0 });
  t.mock.timers.tick(2000);
  assert.equal(h.renderRequests, 0);
  assert.deepEqual(h.widgetLines(), []);
  await h.call("bash_kill", { id: started.details!.id });
});

test("large output stays bounded while expanded UI retains command and process metadata", async (t) => {
  const h = await setup(t);
  const command = "node -e \"process.stdout.write('x'.repeat(20000))\"";
  const started = await h.call("bash_async", { command });
  const render = h.tools.get("bash_async")!.renderResult! as Function;
  const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
  const expanded = render(started, { expanded: true }, theme, {}).render(200).join("\n");
  assert.match(expanded, /PID.*PGID/);
  assert.ok(expanded.includes(started.details!.logPath));
  await waitUntil(() => h.messages.length === 1);
  const { message } = h.messages[0];
  assert.ok(Buffer.byteLength(message.content) <= 16384);
  assert.match(message.content, /truncated/);
  assert.match(message.content, /Logs:/);
  assert.equal(message.details.jobs[0].completion.record.command, command);
  const messageUI = h.renderers.get("async-jobs-completion")!(message, { expanded: true }, theme).render(200).join("\n");
  assert.ok(messageUI.includes(started.details!.logPath));
  assert.ok(messageUI.includes(command));
  for (const tool of h.tools.values()) {
    const refusal = { content: [{ type: "text", text: "Unknown job zz." }], details: {} };
    assert.equal((tool.renderResult! as Function)(refusal, { expanded: true }, theme, {}).render(200).join("\n").trimEnd(), "Unknown job zz.");
  }
});

test("a corrupt registry fails closed instead of overwriting durable state", async (t) => {
  const h = await setup(t, { corrupt: true });
  await assert.rejects(h.call("bash_async", { command: "echo hi" }), /unavailable/);
  assert.ok(h.notifications.some((note) => /failed to load/.test(note)));
});

test("jobs run under the shell resolved from settings.shellPath", async (t) => {
  const h = await setup(t, {
    configure: async (dir) => {
      const shell = join(dir, "custom-shell.sh");
      await writeFile(shell, "#!/bin/sh\necho CUSTOM_SHELL_MARKER\nexec /bin/sh \"$@\"\n", { mode: 0o755 });
      return { shellPath: shell };
    },
  });
  const started = await h.call("bash_async", { command: "echo done" });
  await waitUntil(() => h.messages.length === 1);
  const log = await readFile(started.details!.logPath, "utf8");
  assert.match(log, /CUSTOM_SHELL_MARKER/);
  assert.match(log, /done/);
});

test("an invalid shellPath warns and falls back to the default shell", async (t) => {
  const h = await setup(t, { configure: async (dir) => ({ shellPath: join(dir, "missing-shell") }) });
  assert.ok(h.notifications.some((note) => /ignoring shellPath/.test(note)));
  const started = await h.call("bash_async", { command: "echo fellback" });
  await waitUntil(() => h.messages.length === 1);
  assert.match(await readFile(started.details!.logPath, "utf8"), /fellback/);
});
