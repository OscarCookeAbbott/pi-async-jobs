import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import { stripVTControlCharacters } from "node:util";
import { createBashToolDefinition, createEventBus, initTheme, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import extension from "../src/index.ts";
import { formatCompletions, formatStatus, jobMetadata } from "../src/format.ts";
import { sessionJobsDir, type JobStatus } from "../src/jobs.ts";

type Details = { id: string; logPath: string; title?: string; command?: string; status?: JobStatus };
type OverviewData = { id: string; badge: string; sections: Array<{ title: string; items: Array<{ title: string; state: string; detail?: string }> }> };

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function harness(dir: string, settings: Record<string, unknown> = {}, sessionId = randomUUID()) {
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const bus = createEventBus();
  const overview = new Map<string, OverviewData>();
  const tools = new Map<string, ToolDefinition<TSchema, Details>>();
  const messages: Array<{ message: any; options: any }> = [];
  const renderers = new Map<string, Function>();
  const notifications: string[] = [];
  const events: Array<{ name: string; payload: { event: string; title: string; message: string } }> = [];
  const widgets = new Map<string, any>();
  const views: string[][] = [];
  let command: any;
  let idle = true;
  let renderRequests = 0;
  let widgetUpdates = 0;
  let failNotifications = false;
  let autoDeliver = true;
  let failMessages = false;
  const ctx = {
    mode: "tui",
    cwd: dir,
    isIdle: () => idle,
    sessionManager: { getBranch: () => [], getSessionId: () => sessionId },
    ui: {
      setWidget: (key: string, content: unknown) => { widgetUpdates++; widgets.set(key, content); },
      notify: (text: string) => notifications.push(text),
      custom: async (factory: Function) => {
        const view = factory({ terminal: { rows: 12 }, requestRender() {} }, { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text }, {}, () => {});
        views.push(view.render(80));
        view.handleInput("\r");
        views.push(view.render(200));
        view.handleInput("\x1b");
      },
    },
  } as unknown as ExtensionContext;
  extension({
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerTool: (definition: ToolDefinition<TSchema, Details>) => tools.set(definition.name, definition),
    registerCommand: (_name: string, definition: any) => { command = definition; },
    registerMessageRenderer: (name: string, renderer: Function) => renderers.set(name, renderer),
    getSettings: () => settings,
    events: { on: bus.on, emit: (name: string, payload: unknown) => {
      if (name === "notifications:notify") {
        if (failNotifications) throw new Error("Notification listener unavailable");
        events.push({ name, payload: payload as { event: string; title: string; message: string } });
      }
      if (name === "overview:publish") { const value = payload as OverviewData; overview.set(value.id, value); }
      if (name === "overview:remove") overview.delete(payload as string);
      bus.emit(name, payload);
    } },
    sendMessage: (message: any, options: any) => {
      if (failMessages) throw new Error("Queue unavailable");
      messages.push({ message, options });
      if (autoDeliver) handlers.get("message_end")?.({ message: { role: "custom", ...message } }, ctx);
    },
  } as unknown as ExtensionAPI);
  const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
  return {
    dir, sessionId, tools, messages, renderers, notifications, events, widgets, ctx, emit, bus, overview, views,
    get command() { return command; },
    get renderRequests() { return renderRequests; },
    get widgetUpdates() { return widgetUpdates; },
    setIdle(value: boolean) { idle = value; },
    setAutoDeliver(value: boolean) { autoDeliver = value; },
    failMessages(value = true) { failMessages = value; },
    deliver(index: number) { emit("message_end", { message: { role: "custom", ...messages[index].message } }); },
    failNotifications() { failNotifications = true; },
    async call(name: string, params: JsonObject) {
      const tool = tools.get(name)!;
      // Non-title scenarios use the command as a fixture label; raw title requirements are tested separately.
      const args = name === "bash_async" ? { title: typeof params.command === "string" ? params.command : "Test job", ...params } : params;
      const validated = validateToolArguments(tool, { type: "toolCall", id: "call", name, arguments: args });
      return tool.execute("call", validated, undefined, undefined, ctx as any);
    },
    text(result: { content: Array<{ type: string; text?: string }> }): string {
      return result.content.flatMap((item) => item.type === "text" ? [item.text ?? ""] : []).join("\n");
    },
    widgetLines(width = 80, theme: { fg: (color: string, text: string) => string; bg?: (color: string, text: string) => string } = { fg: (_color, text) => text }): string[] {
      const factory = widgets.get("async-jobs");
      return factory ? factory({ requestRender: () => { renderRequests++; } }, { bg: (_color: string, text: string) => text, ...theme }).render(width) : [];
    },
  };
}

async function setup(t: TestContext, options: { corrupt?: boolean; configure?: (dir: string) => Promise<Record<string, unknown>> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-jobs-ext-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = options.configure ? await options.configure(dir) : {};
  process.env.PI_JOBS_DIR = dir;
  const h = harness(dir, settings);
  if (options.corrupt) {
    await mkdir(sessionJobsDir(h.sessionId), { recursive: true });
    await writeFile(join(sessionJobsDir(h.sessionId), "registry.json"), "not json");
  }
  t.after(() => { h.emit("session_shutdown"); delete process.env.PI_JOBS_DIR; });
  await h.emit("session_start");
  return h;
}

test("independent sessions never adopt, control or receive each other's jobs", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-jobs-isolation-"));
  const previous = process.env.PI_JOBS_DIR;
  process.env.PI_JOBS_DIR = dir;
  const first = harness(dir);
  const second = harness(dir);
  const started: Array<{ harness: ReturnType<typeof harness>; id: string }> = [];
  t.after(async () => {
    for (const job of started) await job.harness.call("bash_kill", { id: job.id }).catch(() => {});
    first.emit("session_shutdown");
    second.emit("session_shutdown");
    if (previous === undefined) delete process.env.PI_JOBS_DIR; else process.env.PI_JOBS_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  await first.emit("session_start");
  const one = await first.call("bash_async", { command: "sleep 30", title: "First thread only" });
  started.push({ harness: first, id: one.details!.id });
  await second.emit("session_start");
  assert.deepEqual(second.widgetLines(), [], "a different thread must not restore the first thread's registry");
  await assert.rejects(second.call("bash_check", { id: one.details!.id }), /Unknown job/);
  await assert.rejects(second.call("bash_kill", { id: one.details!.id }), /Unknown job/);
  const two = await second.call("bash_async", { command: "sleep 30", title: "Second thread only" });
  started.push({ harness: second, id: two.details!.id });
  assert.notEqual(dirname(one.details!.logPath), dirname(two.details!.logPath));
  await second.call("bash_kill", { id: two.details!.id });
  await waitUntil(() => second.messages.length === 1);
  second.emit("session_shutdown");
  assert.equal((await first.call("bash_check", { id: one.details!.id })).details?.status?.running, true);
  assert.match(first.widgetLines().join("\n"), /First thread only/);
  assert.equal(first.messages.length, 0);
  await first.call("bash_kill", { id: one.details!.id });
  await waitUntil(() => first.messages.length === 1);
  assert.match(first.messages[0].message.content, /First thread only/);
  assert.match(second.messages[0].message.content, /Second thread only/);
  assert.doesNotMatch(second.messages[0].message.content, /First thread only/);
});

test("unscoped legacy registries are neither adopted nor rewritten", async (t) => {
  const legacy = "unscoped registry must not be read";
  const h = await setup(t, { configure: async (dir) => {
    await writeFile(join(dir, "registry.json"), legacy);
    return {};
  } });
  assert.deepEqual(h.notifications, []);
  const started = await h.call("bash_async", { command: "printf scoped", title: "Scoped job" });
  assert.equal(dirname(started.details!.logPath), sessionJobsDir(h.sessionId));
  await waitUntil(() => h.messages.length === 1);
  assert.equal(await readFile(join(h.dir, "registry.json"), "utf8"), legacy);
});

test("a session restores its own running jobs without duplicating completion delivery", async (t) => {
  const h = await setup(t);
  const started = await h.call("bash_async", { command: "sleep 30", title: "Own restored job" });
  const id = started.details!.id;
  await h.emit("session_start");
  assert.ok(h.notifications.some((text) => text.includes(`re-attached to ${id}`)));
  assert.equal((await h.call("bash_check", { id })).details?.id, id);
  await h.call("bash_kill", { id });
  await waitUntil(() => h.messages.length === 1);
  assert.match(h.messages[0].message.content, /Own restored job/);
});

test("queued completions and acknowledgements do not cross a session startup boundary", async (t) => {
  const h = await setup(t);
  h.setAutoDeliver(false);
  await h.call("bash_async", { command: "printf OLD_THREAD", title: "Old thread" });
  await waitUntil(() => h.messages.length === 1);
  assert.match(h.widgetLines().join("\n"), /Old thread/);
  const nextSessionId = randomUUID();
  Reflect.set(h.ctx.sessionManager, "getSessionId", () => nextSessionId);
  await h.emit("session_start");
  assert.deepEqual(h.widgetLines(), []);
  const next = await h.call("bash_async", { command: "printf NEW_THREAD", title: "New thread" });
  assert.equal(dirname(next.details!.logPath), sessionJobsDir(nextSessionId));
  await waitUntil(() => h.messages.length === 2);
  assert.match(h.messages[1].message.content, /NEW_THREAD/);
  assert.doesNotMatch(h.messages[1].message.content, /OLD_THREAD/);
  h.deliver(0);
  assert.match(h.widgetLines().join("\n"), /New thread/);
  h.deliver(1);
  assert.deepEqual(h.widgetLines(), []);
});

test("menu shows only currently running jobs, with no badge or completion rows", async (t) => {
  const h = await setup(t);
  const running = await h.call("bash_async", { command: "cat", title: "Live job", timeout: 120 });
  assert.equal(h.overview.get("jobs")!.badge, "");
  assert.equal(h.overview.get("jobs")!.sections[0].items[0].state, "running");
  assert.equal(h.overview.get("jobs")!.sections[0].items[0].title, `Job running: [${running.details!.id}] Live job`);
  await h.call("bash_async", { command: "true" });
  await waitUntil(() => h.messages.length === 1);
  assert.equal(h.overview.get("jobs")!.sections[0].items.length, 1);
  await h.call("bash_kill", { id: running.details!.id });
  assert.equal(h.overview.has("jobs"), false);
});

test("historical full views use archived output rather than a subsequently reused log path", async (t) => {
  const h = await setup(t);
  const started = await h.call("bash_async", { command: "printf 'original'; printf '_tail'" });
  await waitUntil(() => h.messages.length === 1);
  await writeFile(started.details!.logPath, "WRONG_LOG");
  let shown = "";
  Reflect.set(h.ctx.ui, "custom", async (factory: Function) => {
    const view = factory({ terminal: { rows: 100 }, requestRender() {} }, { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text }, {}, () => {});
    view.handleInput("\r");
    shown = view.render(200).join("\n");
  });
  await h.command.handler("", h.ctx);
  assert.match(shown, /original_tail/);
  assert.doesNotMatch(shown, /WRONG_LOG/);
});

test("full-view history restores all completions without republishing finished jobs to the menu", async (t) => {
  const h = await setup(t);
  await h.call("bash_async", { command: "true", title: "Historical job" });
  await waitUntil(() => h.messages.length === 1);
  assert.equal(h.overview.has("jobs"), false);
  const message = h.messages[0].message;
  const completion = message.details.jobs[0].completion;
  const entries = Array.from({ length: 60 }, (_, i) => ({ type: "message", message: {
    role: "custom", customType: "async-jobs-completion", details: { jobs: [{ completion: {
      ...completion, record: { ...completion.record, pid: completion.record.pid + i, start_time: completion.record.start_time + i },
    } }] },
  } }));
  Reflect.set(h.ctx.sessionManager, "getBranch", () => [...entries, { type: "message", message: { role: "custom", customType: "async-jobs-completion", details: { jobs: [{ completion: {} }] } } }]);
  h.overview.clear();
  h.emit("session_tree");
  h.bus.emit("overview:collect", undefined);
  assert.equal(h.overview.has("jobs"), false);
  await h.command.handler("", h.ctx);
  assert.match(h.views[0][0], /1\/60 selected/);
  assert.deepEqual(h.widgetLines(), [], "history must not repopulate acknowledged widget rows");
});

test("registers the four background tools and validates their arguments", async (t) => {
  const h = await setup(t);
  assert.deepEqual([...h.tools.keys()].sort(), ["bash_async", "bash_check", "bash_kill", "bash_send"]);
  const tool = h.tools.get("bash_async")!;
  assert.equal(tool.executionMode, "sequential");
  assert.equal(tool.promptSnippet, "Run lengthy commands without blocking the agent, with automatic completion notifications.");
  assert.ok(tool.description.startsWith(tool.promptSnippet!));
  assert.match(tool.promptGuidelines!.join("\n"), /reserve bash for quick commands/);
  assert.match(tool.promptGuidelines!.join("\n"), /short descriptive title/);
  assert.throws(() => validateToolArguments(tool, { type: "toolCall", id: "missing-title", name: "bash_async", arguments: { command: "true" } }), /title|validation/i);
  await assert.rejects(tool.execute("missing-title", { command: "true" } as any, undefined, undefined, h.ctx as any), /title/i);
  await assert.rejects(h.call("bash_async", { command: "true", title: "\x1b[31m\x1b[0m" }), /title/i);
  assert.match(tool.promptGuidelines!.join("\n"), /continue independent work or end your turn/);
  await assert.rejects(h.call("bash_async", { command: "" }), /validation|minimum/i);
  await assert.rejects(h.call("bash_async", { command: "true", timeout: 0 }), /validation|minimum/i);
  await assert.rejects(h.call("bash_async", { command: "true", title: " " }), /title/);
  await assert.rejects(h.call("bash_check", { id: "!!" }), /validation|pattern/i);
  await assert.rejects(h.call("bash_check", { id: "zz" }), /Unknown job/);
});

test("job titles replace primary command labels without changing execution or debug metadata", async (t) => {
  const h = await setup(t);
  h.setAutoDeliver(false);
  const started = await h.call("bash_async", { command: "printf 'real output'", title: "Friendly build" });
  const id = started.details!.id;
  assert.equal(started.details!.title, "Friendly build");
  await waitUntil(() => h.messages.length === 1);
  assert.match(h.messages[0].message.content, /Friendly build/);
  assert.ok(!h.messages[0].message.content.includes("printf"));
  assert.match(h.messages[0].message.content, /real output/);
  assert.ok(h.widgetLines().some((line) => line.includes("Friendly build") && !line.includes("printf")));
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const header = (h.tools.get("bash_async")!.renderCall! as Function)({ command: "PRIVATE_COMMAND", title: "Friendly build" }, theme, {}).render(200).join("\n");
  assert.match(header, /Friendly build/);
  assert.ok(!header.includes("PRIVATE_COMMAND"));
  assert.equal(started.details!.command, "printf 'real output'");
  assert.equal(h.overview.has("jobs"), false);
  h.bus.emit("overview:collect", undefined);
  assert.equal(h.overview.has("jobs"), false);
  await h.command.handler("", h.ctx);
  assert.match(h.views[0].join("\n"), /Friendly build/);
  assert.match(h.views[1].join("\n"), /printf/);
  h.deliver(0);
  assert.equal(h.overview.has("jobs"), false);
  assert.deepEqual(h.widgetLines(), []);
  assert.ok(h.messages[0].message.details.jobs.some(({ completion }: { completion: { id: string } }) => completion.id === id));
});

test("async call headers use the built-in shell style and show the effective timeout",  () => {
  const h = harness("/unused");
  const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => `<bold>${text}</bold>` };
  const render = h.tools.get("bash_async")!.renderCall! as Function;
  for (const [timeout, suffix] of [[undefined, "timeout 60s"], [120, "timeout 120s"]] as const) {
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

test("started jobs show commands and blue acknowledgements, not agent instructions", () => {
  const h = harness("/unused");
  const command = "printf 'ready\\n'";
  const text = "Job [ab] started in background. Continue independent work or end your turn; completion will notify you automatically.";
  const result = { content: [{ type: "text", text }], details: { id: "ab", pid: 123, pgid: 123, title: "Check readiness", command, logPath: "/tmp/ab.log" } };
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const render = h.tools.get("bash_async")!.renderResult! as Function;
  for (const expanded of [false, true]) {
    const lines: string[] = render(result, { expanded }, theme, {}).render(200);
    const output = lines.map((line) => line.trimEnd()).join("\n");
    assert.match(output, /\x1b\[1m\x1b\[38;2;96;165;250mJob \[ab\] started\.\x1b\[39m\x1b\[22m/);
    assert.ok(output.includes(command));
    assert.equal(output.split(command).length - 1, 1);
    assert.doesNotMatch(output, /Continue independent work|end your turn|notify you automatically/);
    assert.equal(output, `${command}\n\x1b[1m\x1b[38;2;96;165;250mJob [ab] started.\x1b[39m\x1b[22m`);
    assert.ok(render(result, { expanded }, theme, {}).render(12).every((line: string) => visibleWidth(line) <= 12));
  }
  assert.equal(result.content[0].text, text);
  const long = { ...result, details: { ...result.details, command: "FIRST\n" + "middle\n".repeat(30) + "LAST" } };
  const collapsed = render(long, { expanded: false }, theme, {}).render(80).join("\n");
  assert.match(collapsed, /FIRST/);
  assert.match(collapsed, /expand/);
  assert.doesNotMatch(collapsed, /LAST/);
  assert.match(render(long, { expanded: true }, theme, {}).render(80).join("\n"), /LAST/);
  const failure = { content: [{ type: "text", text: "Registry unavailable." }], details: {} };
  assert.match(render(failure, { expanded: false }, theme, { isError: true }).render(80).join("\n"), /Registry unavailable/);
  assert.doesNotMatch(render(result, { expanded: false, isPartial: true }, theme, {}).render(200).join("\n"), /\x1b\[38;2;96;165;250mJob \[ab\] started/);
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
    assert.ok(backgrounds.length > 0 && backgrounds.every((color) => color === "toolSuccessBg"));
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

test("completion notifications expand and collapse when clicked", () => {
  const h = harness("/unused");
  const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
  const content = `Job [ab] succeeded.\nOutput [ab]:\nSTART\n${Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n")}\nFINISH`;
  const message = { content };
  const renderer = h.renderers.get("async-jobs-completion")!;
  const component = renderer(message, { expanded: false, outputPad: 0 }, theme);
  assert.doesNotMatch(component.render(80).join("\n"), /START/);
  assert.deepEqual(component.handleMouse({ type: "click", button: "left" }), { handled: true });
  assert.match(component.render(80).join("\n"), /START/);
  component.handleMouse({ type: "click", button: "left" });
  assert.doesNotMatch(component.render(80).join("\n"), /START/);
  // A click survives a renderer rebuild until the global shortcut changes state.
  assert.doesNotMatch(renderer(message, { expanded: false, outputPad: 0 }, theme).render(80).join("\n"), /START/);
  component.handleMouse({ type: "click", button: "left" });
  assert.match(renderer(message, { expanded: false, outputPad: 0 }, theme).render(80).join("\n"), /START/);
  assert.match(renderer(message, { expanded: true, outputPad: 0 }, theme).render(80).join("\n"), /START/);
  assert.doesNotMatch(renderer(message, { expanded: false, outputPad: 0 }, theme).render(80).join("\n"), /START/);
});

test("a finished job produces one merged completion frame and triggers a turn when idle", async (t) => {
  const h = await setup(t);
  h.setIdle(true);
  const started = await h.call("bash_async", { command: "printf 'hi\\n'" });
  const { id } = started.details!;
  await waitUntil(() => h.messages.length === 1);
  assert.equal(h.messages[0].message.customType, "async-jobs-completion");
  assert.equal(h.messages[0].options.triggerTurn, true);
  assert.match(h.messages[0].message.content, /Job succeeded: \[[0-9a-z]{2}\]/);
  assert.equal(h.text(started), `Job [${id}] started in background. Continue independent work or end your turn; completion will notify you automatically.`);
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

test("job overflow is shown beside counts in the header rather than a footer", async (t) => {
  const h = await setup(t);
  for (let i = 0; i < 7; i++) {
    await h.call("bash_async", { command: "cat", timeout: 120, title: `Job ${i}` });
    if (i === 5) {
      assert.equal(h.widgetLines(100).length, 7);
      assert.doesNotMatch(h.widgetLines(100)[0], /Showing/);
    }
  }
  const lines = h.widgetLines(100);
  assert.equal(lines[0], "Jobs · 7 running · Showing 1-6/7");
  assert.equal(lines.length, 7);
  assert.ok(lines.slice(1).every((line) => !line.includes("more") && !line.includes("Showing")));
  await h.command.handler("kill-all", h.ctx);
});

test("running jobs appear in the widget and can be inspected, fed, and killed", async (t) => {
  const h = await setup(t);
  const started = await h.call("bash_async", { command: "cat", timeout: 120 });
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
  assert.ok(h.views[0].join("\n").includes(id));
  assert.match(h.views[1].join("\n"), /PID.*PGID/);
  assert.match(h.views[1].join("\n"), /Command:/);
  assert.equal(h.text(await h.call("bash_kill", { id })), `Job [${id}] terminated.`);
  const finished = h.widgetLines();
  assert.match(finished[0]!, /1 finished/);
  assert.ok(finished.some((line) => line.includes(id)));
  await waitUntil(() => h.messages.length > 0);
  assert.deepEqual(h.widgetLines(), []);
});

test("running durations redraw once per second without rebuilding widgets or messaging the agent", async (t) => {
  const h = await setup(t);
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  const started = await h.call("bash_async", { command: "cat\n# " + "💜".repeat(80) + "\t\r", timeout: 120 });
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
  const finished = h.widgetLines();
  assert.match(finished[0]!, /1 finished/);
  assert.ok(finished.some((line) => line.includes(id)));
});

test("successful job UI matches bash duration footers without changing agent feedback", () => {
  initTheme("dark");
  const h = harness("/unused");
  const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
  const plain = (component: { render: (width: number) => string[] }) => stripVTControlCharacters(component.render(200).map((line) => line.trimEnd()).join("\n")).trim();
  const bash = createBashToolDefinition("/unused");
  for (const runtimeSeconds of [0, 14.25, 60, 3661]) {
    const builtin = plain((bash.renderResult! as Function)({ content: [{ type: "text", text: "REAL_OUTPUT" }], details: {} }, { expanded: true, isPartial: false }, theme, { state: {}, durationMs: runtimeSeconds * 1000, showImages: false }));
    const footer = builtin.split("\n").at(-1)!;
    const completion = { id: "ab", record: { pid: 123, pgid: 123, command: "echo REAL_OUTPUT", title: "Check output", log_path: "/tmp/ab.log", start_time: 0, timeout: 7200 }, exitCode: 0, signal: null, timedOut: false, runtimeSeconds };
    const tail = { text: Array.from({ length: 8 }, (_, index) => `line ${index}`).join("\n") + "\nREAL_OUTPUT\n\n", truncated: false };
    const content = formatCompletions([{ completion, tail }]);
    const status = { ...completion, running: false, tail };
    const result = { content: [{ type: "text", text: formatStatus(status) }], details: { ...jobMetadata("ab", completion.record), status } };
    const message = { customType: "async-jobs-completion", content, details: { jobs: [{ completion, tail }] } };
    for (const expanded of [false, true]) {
      const outputs = [
        plain(h.renderers.get("async-jobs-completion")!(message, { expanded, outputPad: 0 }, theme)),
        plain((h.tools.get("bash_check")!.renderResult! as Function)(result, { expanded }, theme, {})),
      ];
      for (const output of outputs) {
        assert.ok(output.endsWith(`\n\n${footer}`), output);
        assert.match(output, /REAL_OUTPUT/);
        assert.doesNotMatch(output, /Check output \([\d.]+s\)/);
        assert.equal(output.split(footer).length - 1, 1);
        if (!expanded) {
          assert.match(output, /line 4/);
          assert.doesNotMatch(output, /line 3/);
        }
      }
    }
    assert.equal(message.content, content);
    assert.ok(message.content.includes(`Job succeeded: [ab] Check output (${runtimeSeconds}s)`));
    assert.equal(result.content[0].text, formatStatus(status));
  }
});

test("successful and failed jobs use distinct semantic backgrounds with normal text", () => {
  const h = harness("/unused");
  const jobs = ["ab", "cd"].map((id, index) => ({
    completion: {
      id, record: { pid: index + 1, pgid: index + 1, command: "example", log_path: `/tmp/${id}.log`, start_time: 0, timeout: 60 },
      exitCode: index === 0 ? 0 : 2, signal: null, timedOut: false, runtimeSeconds: 1,
    },
    tail: { text: index === 0 ? "Success output" : "Failure output", truncated: false },
  }));
  const message = { customType: "async-jobs-completion", content: formatCompletions(jobs), details: { jobs } };
  for (const expanded of [false, true]) {
    const colours: Array<{ colour: string; text: string }> = [];
    const backgrounds: Array<{ colour: string; text: string }> = [];
    const theme = {
      fg: (colour: string, text: string) => { colours.push({ colour, text }); return text; },
      bg: (colour: string, text: string) => { backgrounds.push({ colour, text }); return text; }, bold: (text: string) => text,
    };
    const output = h.renderers.get("async-jobs-completion")!(message, { expanded, outputPad: 0 }, theme).render(200).join("\n");
    assert.equal(output.split("Took 1.0s").length - 1, 1, "only the successful section gets a footer");
    assert.match(output, /Job failed \(exit 2\): \[cd\] example \(1s\)/);
    assert.ok(colours.every(({ colour }) => colour !== "error"), `failure text must remain normal (expanded=${expanded})`);
    assert.ok(backgrounds.some(({ colour, text }) => colour === "toolErrorBg" && text.includes("Job failed (exit 2): [cd]")));
    assert.ok(backgrounds.some(({ colour, text }) => colour === "toolSuccessBg" && text.includes("Job succeeded: [ab]")));
    assert.ok(!backgrounds.some(({ colour, text }) => colour === "toolErrorBg" && text.includes("Job succeeded: [ab]")));
    colours.length = 0;
    backgrounds.length = 0;
    const failed = jobs[1];
    (h.tools.get("bash_check")!.renderResult! as Function)({
      content: [{ type: "text", text: "Failed job status" }],
      details: { ...jobMetadata(failed.completion.id, failed.completion.record), status: { ...failed.completion, running: false, tail: failed.tail } },
    }, { expanded }, theme, { isError: false }).render(200);
    assert.ok(colours.every(({ colour }) => colour !== "error"));
    assert.ok(backgrounds.some(({ colour, text }) => colour === "toolErrorBg" && text.includes("Failed job status")));
    backgrounds.length = 0;
    const success = jobs[0];
    (h.tools.get("bash_check")!.renderResult! as Function)({
      content: [{ type: "text", text: "Successful job status" }],
      details: { ...jobMetadata(success.completion.id, success.completion.record), status: { ...success.completion, running: false, tail: success.tail } },
    }, { expanded }, theme, { isError: false }).render(200);
    assert.ok(backgrounds.some(({ colour, text }) => colour === "toolSuccessBg" && text.includes("Successful job status")));
    assert.ok(colours.every(({ colour }) => colour !== "error" && colour !== "success"));
  }
});

test("queued completions stay visible until their matching message reaches the agent", async (t) => {
  const h = await setup(t);
  h.setIdle(false);
  h.setAutoDeliver(false);
  await h.call("bash_async", { command: "printf 'one\\n'" });
  await waitUntil(() => h.messages.length === 1);
  assert.ok(h.widgetLines().some((line) => line.includes("one")), "Queueing must not remove the finished row");
  assert.equal(h.messages[0].options.deliverAs, "steer");
  h.emit("message_end", { message: { role: "custom", customType: "async-jobs-completion", details: { notificationId: "unrelated" } } });
  assert.ok(h.widgetLines().some((line) => line.includes("one")));
  await h.call("bash_async", { command: "printf 'two\\n'" });
  await waitUntil(() => h.messages.length === 2);
  assert.ok(h.widgetLines().some((line) => line.includes("one")));
  assert.ok(h.widgetLines().some((line) => line.includes("two")));
  assert.equal(h.messages[1].message.details.jobs.length, 1, "Already queued jobs must not be sent twice");
  const secondRow = h.widgetLines().find((line) => line.includes("two"));
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(60000);
  h.deliver(0);
  assert.equal(h.widgetLines().find((line) => line.includes("two")), secondRow, "Finished duration must not grow while waiting for delivery");
  assert.ok(!h.widgetLines().some((line) => line.includes("one")));
  assert.ok(h.widgetLines().some((line) => line.includes("two")));
  h.deliver(0);
  assert.ok(h.widgetLines().some((line) => line.includes("two")), "Duplicate acknowledgements must not remove a newer completion");
  h.deliver(1);
  assert.deepEqual(h.widgetLines(), []);
});

test("queue failures retain finished jobs for a later delivery attempt", async (t) => {
  const h = await setup(t);
  h.failMessages();
  await h.call("bash_async", { command: "exit 7" });
  await waitUntil(() => h.notifications.some((text) => text.includes("could not be queued")));
  assert.equal(h.messages.length, 0);
  assert.match(h.widgetLines()[0], /1 finished/);
  h.failMessages(false);
  await h.call("bash_async", { command: "true" });
  await waitUntil(() => h.messages.length === 1);
  assert.equal(h.messages[0].message.details.jobs.length, 2);
  assert.deepEqual(h.widgetLines(), []);
});

test("persistent finished-job rows use status foregrounds, never thread outcome backgrounds", async (t) => {
  const h = await setup(t);
  h.setAutoDeliver(false);
  for (const [index, command, color, marker] of [[0, "exit 3", "error", "✗"], [1, "true", "success", "✓"]] as const) {
    const started = await h.call("bash_async", { command });
    await waitUntil(() => h.messages.length === index + 1);
    const colors: string[] = [];
    const backgrounds: string[] = [];
    const finished = h.widgetLines(80, {
      fg: (value, text) => { colors.push(value); return text; },
      bg: (value, text) => { backgrounds.push(value); return text; },
    });
    assert.match(finished[0]!, /1 finished/);
    assert.ok(finished[1]!.startsWith(`${marker} Job `));
    assert.ok(finished[1]!.includes(`: [${started.details!.id}] `));
    assert.ok(colors.includes(color));
    assert.deepEqual(backgrounds, []);
    h.deliver(index);
    assert.deepEqual(h.widgetLines(), []);
  }
});

test("non-interactive jobs do not start UI refreshes", async (t) => {
  const h = await setup(t);
  Reflect.set(h.ctx, "mode", "print");
  t.mock.timers.enable({ apis: ["setInterval"] });
  const started = await h.call("bash_async", { command: "cat", timeout: 120 });
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
  assert.ok(expanded.includes(command));
  assert.doesNotMatch(expanded, /PID|PGID|Log:|Continue independent/);
  assert.ok(!expanded.includes(started.details!.logPath));
  await waitUntil(() => h.messages.length === 1);
  const status = await h.call("bash_check", { id: started.details!.id });
  const inspected = (h.tools.get("bash_check")!.renderResult! as Function)(status, { expanded: true }, theme, {}).render(200).join("\n");
  assert.match(inspected, /PID.*PGID/);
  assert.ok(inspected.includes(started.details!.logPath));
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

test("desktop notifications default off and filter job changes without exposing commands or input", async (t) => {
  for (const mode of [undefined, "none", "started", "completed", "all", "invalid", true, null]) {
    await t.test(`mode ${mode}`, async (t) => {
      const h = await setup(t, { configure: async () => mode === undefined ? {} : { asyncJobs: { notifications: mode } } });
      const started = await h.call("bash_async", { command: "cat\n# PRIVATE_COMMAND", timeout: 120, title: "Process input" });
      const id = started.details!.id;
      await h.call("bash_send", { id, input: "PRIVATE_INPUT" });
      await h.call("bash_check", { id });
      await h.call("bash_kill", { id });
      await waitUntil(() => h.messages.length === 1);
      const expected = ["started", "input", "completed", "terminated"].filter((event) => mode === "all" || mode === event).map((event) => `jobs.${event}`);
      assert.deepEqual(h.events.map(({ payload }) => payload.event), expected);
      if (mode === "all") {
        assert.equal(h.events.find(({ payload }) => payload.event === "jobs.started")!.payload.message, `Job started: [${id}] Process input`);
        assert.ok(h.events.find(({ payload }) => payload.event === "jobs.completed")!.payload.message.endsWith(`: [${id}] Process input`));
      }
      assert.ok(h.events.every(({ name, payload }) => name === "notifications:notify" && payload.title === "Pi Jobs" && !/PRIVATE/.test(payload.message)));
      if (mode === "invalid" || mode === true || mode === null) assert.match(h.notifications[0], /asyncJobs.notifications/);
      const count = h.events.length;
      await assert.rejects(h.call("bash_send", { id: "!!", input: "No" }));
      await assert.rejects(h.call("bash_kill", { id: "!!" }));
      await assert.rejects(h.call("bash_async", { command: " " }));
      assert.equal(h.events.length, count);
    });
  }
});

test("command-based kills notify and broken optional consumers never affect job control", async (t) => {
  const h = await setup(t, { configure: async () => ({ asyncJobs: { notifications: "all" } }) });
  const first = await h.call("bash_async", { command: "cat", timeout: 120 });
  await h.command.handler(`kill ${first.details!.id}`, h.ctx);
  const second = await h.call("bash_async", { command: "cat", timeout: 120 });
  await h.command.handler("kill-all", h.ctx);
  assert.equal(h.events.filter(({ payload }) => payload.event === "jobs.terminated").length, 2);
  assert.ok(h.events.some(({ payload }) => payload.event === "jobs.completed" && payload.message.includes(second.details!.id)));
  h.failNotifications();
  const third = await h.call("bash_async", { command: "cat", timeout: 120 });
  await h.call("bash_send", { id: third.details!.id, input: "hi" });
  await h.call("bash_kill", { id: third.details!.id });
  await waitUntil(() => h.messages.some(({ message }) => message.details.jobs.some(({ completion }: { completion: { id: string } }) => completion.id === third.details!.id)));
});

test("settled preparation replaces the default only while jobs run, even with job notifications off", async (t) => {
  const h = await setup(t);
  const prepare = (event = "agent_settled") => {
    const draft = { event, title: "Pi", message: "Agent finished:" };
    h.bus.emit("notifications:prepare", draft);
    return draft.message;
  };
  assert.equal(prepare(), "Agent finished:");
  const first = await h.call("bash_async", { command: "cat\n# PRIVATE_COMMAND", timeout: 120, title: "Process input" });
  const second = await h.call("bash_async", { command: "cat", timeout: 120 });
  assert.equal(prepare("turn_end"), "Agent finished:");
  const message = prepare();
  assert.match(message, /^Agent finished: Jobs running:/);
  assert.deepEqual(message.match(/\[[0-9a-z]{2}\]/g)?.sort(), [`[${first.details!.id}]`, `[${second.details!.id}]`].sort());
  assert.ok(!message.includes("PRIVATE_COMMAND"));
  await h.call("bash_kill", { id: first.details!.id });
  assert.equal(prepare(), `Agent finished: Jobs running: [${second.details!.id}].`);
  let assignments = 0;
  h.bus.emit("notifications:prepare", { event: "agent_settled", set message(_value: string) { assignments++; } });
  assert.equal(assignments, 1, "Exactly one preparation hook should contribute");
  assert.deepEqual(h.events, [], "Preparation must not emit a second notification or require job-change notifications");
  await h.call("bash_kill", { id: second.details!.id });
  assert.equal(prepare(), "Agent finished:");
  h.emit("session_shutdown");
  assert.equal(prepare(), "Agent finished:");
  h.emit("session_shutdown");
});
