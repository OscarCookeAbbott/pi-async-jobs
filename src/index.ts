import { randomUUID } from "node:crypto";
import { getShellConfig, keyText, truncateHead, truncateToVisualLines, type ExtensionAPI, type ExtensionContext, type Theme, type ThemeColor, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createBrowser } from "./browser.ts";
import { completionKey, restoreCompletions, type HistoryCompletion } from "./history.ts";
import { formatCompletions, formatJobDuration, formatJobLine, formatJobSummary, formatMetadata, formatStatus, jobLabel, jobMetadata, jobOutcome, type CompletionFeedback, type JobMetadata, type JobOutcome } from "./format.ts";
import { DEFAULT_TIMEOUT, MAX_TIMEOUT, JobManager, TAIL_LINES, sessionJobsDir, tailFile, type JobCompletion, type JobStatus, type ShellCommand } from "./jobs.ts";

type NotificationMode = "none" | "started" | "completed" | "all";

const COMPLETION_TAIL_LINES = 20;
const UI_TRUNCATION_NOTE = "[Details truncated; inspect the log file for full output.]";
const id = Type.String({ pattern: "^[0-9a-z]{2}$", description: "Two-character job ID" });
const uiText = (text: string): string => {
  const shown = truncateHead(text, { maxLines: 500, maxBytes: 30000 });
  return shown.content + (shown.truncated ? `\n${UI_TRUNCATION_NOTE}` : "");
};
const highlight = (text: string): string => `\x1b[1m\x1b[38;2;96;165;250m${text}\x1b[39m\x1b[22m`;

function outputPreview(text: string, expanded: boolean, theme: Theme, from: "start" | "end" = "end"): Component {
  if (expanded) return new Text(text, 0, 0);
  let lastWidth: number | undefined;
  let cached: string[] = [];
  return {
    render(width) {
      if (width < 1) return [];
      if (width !== lastWidth) {
        const preview = truncateToVisualLines(text, 5, width, 0, from);
        const key = keyText("app.tools.expand");
        const hint = theme.fg("muted", `... (${preview.skippedCount} ${from === "start" ? "later" : "earlier"} lines; ${key ? `${key} to expand` : "expand for full output"})`);
        const hintLines = preview.skippedCount ? [truncateToWidth(hint, width)] : [];
        cached = from === "start" ? [...preview.visualLines, ...hintLines] : [...hintLines, ...preview.visualLines];
        lastWidth = width;
      }
      return cached;
    },
    invalidate() { lastWidth = undefined; },
  };
}

const OUTCOME_COLORS: Record<JobOutcome, ThemeColor> = {
  running: "accent",
  success: "toolOutput",
  failure: "toolOutput",
  timeout: "warning",
  signal: "warning",
  unknown: "dim",
};

const WIDGET_OUTCOME_COLORS: Record<JobOutcome, ThemeColor> = { ...OUTCOME_COLORS, success: "success", failure: "error" };

function outcomeBackground(outcome: JobOutcome): "toolSuccessBg" | "toolErrorBg" | undefined {
  if (outcome === "success") return "toolSuccessBg";
  if (outcome === "failure") return "toolErrorBg";
}

function completionColor(completion: JobCompletion): ThemeColor {
  const outcome = jobOutcome(completion);
  return outcome === "success" || outcome === "failure" ? "toolTitle" : OUTCOME_COLORS[outcome];
}

function completionHeadingId(line: string): string | undefined {
  return /^Job(?: [^:]*)?: \[([0-9a-z]{2})\](?: |$)/.exec(line)?.[1] ?? /^Job \[([0-9a-z]{2})\] /.exec(line)?.[1];
}

function completionHeadingColor(line: string, jobs: CompletionFeedback[], fallback: ThemeColor): ThemeColor {
  const id = completionHeadingId(line);
  if (!id) return fallback;
  const job = jobs.find(({ completion }) => completion.id === id);
  if (job) return completionColor(job.completion);
  if (/^Job (timed out|terminated)\b/.test(line) || /^Job \[[0-9a-z]{2}\] (timed out|terminated)\b/.test(line)) return "warning";
  return "toolTitle";
}

interface MessageExpansion {
  global: boolean;
  expanded: boolean;
}

interface MessageIdentity {
  readonly customType: string;
}

const messageExpansion = new WeakMap<MessageIdentity, MessageExpansion>();

/** Keep click expansion local while still following the global tool-output shortcut. */
function expandableMessage(message: MessageIdentity, expanded: boolean, build: (expanded: boolean) => Component): Component {
  let state = messageExpansion.get(message);
  if (!state || state.global !== expanded) {
    state = { global: expanded, expanded };
    messageExpansion.set(message, state);
  }
  const expansion = state;
  let content = build(expansion.expanded);
  return {
    render(width) { return content.render(width); },
    invalidate() { content.invalidate(); },
    handleMouse(event) {
      if (event.type !== "click" || event.button !== "left") return undefined;
      expansion.expanded = !expansion.expanded;
      content = build(expansion.expanded);
      return { handled: true };
    },
  };
}

const renderStartedResult: NonNullable<ToolDefinition["renderResult"]> = (result, options, theme, context) => {
  const metadata = result.details as JobMetadata | undefined;
  if (context?.isError || options.isPartial || typeof metadata?.command !== "string" || typeof metadata.id !== "string") return renderResult(result, options, theme, context);
  const component = new Container();
  component.addChild(outputPreview(theme.fg("toolOutput", uiText(metadata.command)), options.expanded, theme, "start"));
  component.addChild(new Text(highlight(`Job [${metadata.id}] started.`), 0, 0));
  return component;
};

const renderResult: NonNullable<ToolDefinition["renderResult"]> = (result, { expanded, isPartial }, theme, context) => {
  const text = result.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
  const metadata = result.details as (JobMetadata & { status?: JobStatus }) | undefined;
  const background = metadata?.status && outcomeBackground(jobOutcome(metadata.status));
  const color = context?.isError ? "error" : "toolOutput";
  const successStatus = !context?.isError && !isPartial && metadata?.status && jobOutcome(metadata.status) === "success" ? metadata.status : undefined;
  const [originalHeading = "", ...body] = uiText(successStatus ? text.trimEnd() : text).split("\n");
  let heading = originalHeading;
  if (successStatus) {
    const prefix = `Job [${successStatus.id}] succeeded (${successStatus.runtimeSeconds}s):`;
    if (heading === formatJobSummary(successStatus)) heading = formatJobSummary(successStatus, false);
    else if (heading.startsWith(prefix)) heading = `Job succeeded: [${successStatus.id}]` + heading.slice(prefix.length);
  }
  const component = new Container();
  const emphasize = typeof metadata?.id === "string" && !context?.isError && !isPartial && (!metadata.status || metadata.status.running);
  component.addChild(new Text(theme.fg(color, emphasize ? highlight(heading) : heading), 0, 0));
  if (body.length) component.addChild(outputPreview(theme.fg(color, body.join("\n")), expanded, theme));
  if (expanded && typeof metadata?.command === "string") {
    const detail = formatMetadata(metadata);
    component.addChild(new Text(theme.fg("muted", uiText(successStatus ? detail.trimEnd() : detail)), 0, 0));
  }
  if (successStatus) component.addChild(new Text(`\n${theme.fg("muted", `Took ${formatJobDuration(successStatus.runtimeSeconds)}`)}`, 0, 0));
  if (!background) return component;
  const box = new Box(0, 0, (line) => theme.bg(background, line));
  box.addChild(component);
  return box;
};

export default function asyncJobsExtension(pi: ExtensionAPI): void {
  let manager: JobManager | undefined;
  let loadError: string | undefined;
  let ctxRef: ExtensionContext | undefined;
  let pending: JobCompletion[] = [];
  const history = new Map<string, HistoryCompletion>();
  const pendingBatches = new Map<string, JobCompletion[]>();
  let flushTimer: NodeJS.Timeout | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;
  let requestWidgetRender: (() => void) | undefined;
  let removeExitHook: (() => void) | undefined;
  let removeNotificationHook: (() => void) | undefined;
  let removeOverviewHook: (() => void) | undefined;
  let notificationMode: NotificationMode = "none";
  const debounceMs = Number(process.env.PI_JOBS_DEBOUNCE_MS ?? 200);

  function notifyChange(event: "started" | "completed" | "input" | "terminated", message: string): void {
    if (notificationMode !== "all" && notificationMode !== event) return;
    try {
      pi.events.emit("notifications:notify", { event: `jobs.${event}`, title: "Pi Jobs", message });
    } catch {
      // Optional notification delivery must not affect job control or completion.
    }
  }

  function requireManager(): JobManager {
    if (loadError) throw new Error(`Async jobs registry is unavailable: ${loadError}`);
    if (!manager) throw new Error("Async jobs are not ready yet.");
    return manager;
  }

  /** Use the same resolved shell as the built-in bash tool, honouring settings.shellPath. */
  function resolveShell(ctx: ExtensionContext): ShellCommand {
    try {
      const config = getShellConfig(pi.getSettings().shellPath);
      return { shell: config.shell, args: [...config.args], transport: config.commandTransport };
    } catch (error) {
      ctx.ui.notify(`Async jobs: ignoring shellPath (${error instanceof Error ? error.message : String(error)}); falling back to the default shell.`, "warning");
      try {
        const fallback = getShellConfig();
        return { shell: fallback.shell, args: [...fallback.args], transport: fallback.commandTransport };
      } catch {
        return { shell: "sh", args: ["-c"] };
      }
    }
  }

  function stopWidgetRefresh(): void {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    requestWidgetRender = undefined;
  }

  function publishOverview(): void {
    if (!ctxRef) return;
    try {
      const active = loadError ? [] : (manager?.active() ?? []).filter(({ running }) => running);
      const items = active.map(({ id, record }) => ({
        title: `[${id}] ${jobLabel(record)}`, state: "running", kind: "job", subtitle: `Running · timeout ${record.timeout}s`, body: record.command,
        detail: `${formatMetadata(jobMetadata(id, record))}\nStatus: Running\nTimeout: ${record.timeout}s`,
      }));
      if (!items.length) { pi.events.emit("overview:remove", "jobs"); return; }
      pi.events.emit("overview:publish", { id: "jobs", badge: "", sections: [{ title: "Running jobs", items }] });
    } catch { /* Overview is optional and must not affect jobs. */ }
  }
  function subscribeOverview(): void {
    if (!removeOverviewHook) removeOverviewHook = pi.events.on("overview:collect", publishOverview);
  }
  subscribeOverview();

  function updateWidget(): void {
    publishOverview();
    const ctx = ctxRef;
    if (!ctx || ctx.mode !== "tui") {
      stopWidgetRefresh();
      return;
    }
    const active = manager?.active() ?? [];
    const finished = pending.map((completion) => ({
      id: completion.id,
      record: completion.record,
      running: false,
      outcome: jobOutcome(completion),
      runtimeSeconds: completion.runtimeSeconds,
    }));
    const jobs = [
      ...active.map(({ id, record, running }) => ({ id, record, running, outcome: jobOutcome({ running }), runtimeSeconds: undefined })),
      ...finished,
    ];
    if (!jobs.length) {
      stopWidgetRefresh();
      ctx.ui.setWidget("async-jobs", undefined);
      return;
    }
    const runningCount = jobs.filter(({ running }) => running).length;
    const finishedCount = jobs.length - runningCount;
    if (!runningCount) stopWidgetRefresh();
    const headingText = ["Jobs", runningCount ? `${runningCount} running` : "", finishedCount ? `${finishedCount} finished` : "", jobs.length > 6 ? `Showing 1-6/${jobs.length}` : ""].filter(Boolean).join(" · ");
    ctx.ui.setWidget("async-jobs", (tui, theme) => {
      requestWidgetRender = () => tui.requestRender();
      return {
        render(width: number): string[] {
          const heading = truncateToWidth(theme.fg("muted", headingText), width);
          const now = Math.floor(Date.now() / 1000);
          return [
            heading,
            ...jobs.slice(0, 6).map(({ id, record, running, outcome, runtimeSeconds }) => {
              return truncateToWidth(theme.fg(WIDGET_OUTCOME_COLORS[outcome], formatJobLine(id, record.title ?? record.command, running, runtimeSeconds ?? Math.max(0, now - record.start_time), outcome)), width);
            }),
          ];
        },
        invalidate() {},
      };
    });
    if (!refreshTimer && runningCount) {
      refreshTimer = setInterval(() => requestWidgetRender?.(), 1000);
      refreshTimer.unref?.();
    }
  }

  async function flush(): Promise<void> {
    flushTimer = undefined;
    const alreadyQueued = new Set([...pendingBatches.values()].flat());
    const batch = pending.filter((completion) => !alreadyQueued.has(completion));
    if (!batch.length) return;
    const notificationId = randomUUID();
    pendingBatches.set(notificationId, batch);
    try {
      const jobs = await Promise.all(batch.map(async (completion) => ({ completion, tail: await tailFile(completion.record.log_path, COMPLETION_TAIL_LINES) })));
      if (!pendingBatches.has(notificationId)) return;
      for (const { completion, tail } of jobs) history.set(completionKey(completion), { ...completion, tail });
      const content = formatCompletions(jobs);
      // Queuing is not delivery. message_end acknowledges when Pi consumes this exact frame.
      pi.sendMessage({ customType: "async-jobs-completion", content, display: true, details: { jobs, notificationId } }, ctxRef && !ctxRef.isIdle() ? { deliverAs: "steer" } : { triggerTurn: true });
    } catch (error) {
      pendingBatches.delete(notificationId);
      try { ctxRef?.ui.notify(`Async job completion could not be queued; finished rows retained: ${error instanceof Error ? error.message : String(error)}`, "warning"); } catch { /* Non-interactive delivery does not require UI. */ }
    } finally {
      updateWidget();
    }
  }

  function enqueue(completion: JobCompletion): void {
    history.set(completionKey(completion), completion);
    notifyChange("completed", completion.record.title ? `Job finished (${jobOutcome(completion)}): [${completion.id}] ${completion.record.title}` : `Job [${completion.id}] finished: ${jobOutcome(completion)}.`);
    pending.push(completion);
    if (!flushTimer) flushTimer = setTimeout(() => void flush().catch(() => {}), Number.isFinite(debounceMs) ? debounceMs : 200);
    updateWidget();
  }

  pi.registerMessageRenderer<{ jobs: CompletionFeedback[]; notificationId?: string }>("async-jobs-completion", (message, { expanded, outputPad }, theme) => {
    const content = typeof message.content === "string" ? message.content : message.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
    return expandableMessage(message, expanded, (showDetails) => {
      const jobs = message.details?.jobs ?? [];
      let fallbackOutcome: JobOutcome = "unknown";
      if (/^Job (?:\[[0-9a-z]{2}\] )?failed\b/m.test(content)) fallbackOutcome = "failure";
      else if (/^Job (?:\[[0-9a-z]{2}\] )?succeeded\b/m.test(content)) fallbackOutcome = "success";
      const sections = jobs.length
        ? jobs.map((job) => {
          const outcome = jobOutcome(job.completion);
          const successful = outcome === "success";
          const status = formatStatus({ ...job.completion, running: false, tail: job.tail }, { includeRuntime: !successful });
          const collapsed = successful ? status : formatCompletions([job]);
          const text = showDetails ? `${formatMetadata(jobMetadata(job.completion.id, job.completion.record))}\n${status}` : collapsed;
          const footer = successful ? `Took ${formatJobDuration(job.completion.runtimeSeconds)}` : undefined;
          return {
            text: footer ? `${text.trimEnd()}\n\n${footer}` : text,
            footer, jobs: [job], colour: completionColor(job.completion), background: outcomeBackground(outcome),
          };
        })
        : [{ text: content, footer: undefined, jobs, colour: "toolTitle" as ThemeColor, background: outcomeBackground(fallbackOutcome) }];
      const shown = truncateHead(sections.map(({ text }) => text).join("\n\n"), { maxLines: 500, maxBytes: 30000 });
      const container = new Container();
      let offset = 0;
      sections.forEach((section) => {
        const box = new Box(outputPad ?? 1, 1, (line) => theme.bg(section.background ?? "customMessageBg", line));
        let text = shown.content.slice(offset, offset + section.text.length);
        offset += section.text.length + 2;
        if (!text) return;
        const footer = text.length === section.text.length ? section.footer : undefined;
        if (footer) text = text.slice(0, -footer.length - 2);
        let heading = true;
        const headings: string[] = [];
        const body: string[] = [];
        const bodyColour = section.colour === "toolTitle" ? "customMessageText" : section.colour;
        text.split("\n").forEach((line, index) => {
          if (index > 0 && !completionHeadingId(line)) heading = false;
          if (heading) headings.push(theme.fg(completionHeadingColor(line, section.jobs, section.colour), theme.bold(line)));
          else body.push(theme.fg(bodyColour, line));
        });
        box.addChild(new Text(headings.join("\n"), 0, 0));
        if (body.length) box.addChild(outputPreview(body.join("\n"), showDetails, theme));
        if (footer) box.addChild(new Text(`\n${theme.fg("muted", footer)}`, 0, 0));
        container.addChild(box);
      });
      if (shown.truncated) container.addChild(new Text(theme.fg("muted", UI_TRUNCATION_NOTE), 0, 0));
      return container;
    });
  });

  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "custom" || message.customType !== "async-jobs-completion") return;
    const notificationId = (message.details as { notificationId?: unknown } | undefined)?.notificationId;
    if (typeof notificationId !== "string") return;
    const batch = pendingBatches.get(notificationId);
    if (!batch) return;
    pendingBatches.delete(notificationId);
    pending = pending.filter((completion) => !batch.includes(completion));
    updateWidget();
  });

  function restoreHistory(ctx: ExtensionContext): void {
    const queued = pending.map((completion) => history.get(completionKey(completion)) ?? completion);
    history.clear();
    for (const completion of [...restoreCompletions(ctx.sessionManager.getBranch()), ...queued]) history.set(completionKey(completion), completion);
  }

  pi.on("session_tree", (_event, ctx) => { ctxRef = ctx; restoreHistory(ctx); updateWidget(); });

  pi.on("session_start", async (_event, ctx) => {
    stopWidgetRefresh();
    manager?.dispose();
    manager = undefined;
    removeExitHook?.();
    removeExitHook = undefined;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    pending = [];
    pendingBatches.clear();
    restoreHistory(ctx);
    ctxRef = ctx;
    subscribeOverview();
    removeNotificationHook?.();
    removeNotificationHook = undefined;
    notificationMode = "none";
    try {
      const configured = (pi.getSettings() as { asyncJobs?: { notifications?: unknown } }).asyncJobs?.notifications;
      if (configured !== undefined && !["none", "started", "completed", "all"].includes(configured as string)) throw new Error("asyncJobs.notifications must be none, started, completed, or all.");
      notificationMode = (configured ?? "none") as NotificationMode;
    } catch (error) {
      ctx.ui.notify(`Async jobs: ${error instanceof Error ? error.message : String(error)} Desktop notifications disabled.`, "warning");
    }
    loadError = undefined;
    try {
      manager = new JobManager(sessionJobsDir(ctx.sessionManager.getSessionId()), { shell: resolveShell(ctx) });
      const { restored, reaped } = await manager.load();
      if (restored.length) ctx.ui.notify(`Async jobs: re-attached to ${restored.join(", ")}.`, "info");
      else if (reaped.length) ctx.ui.notify(`Async jobs: cleaned up ${reaped.length} stale job(s).`, "info");
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Async jobs registry failed to load: ${loadError}`, "error");
    }
    manager?.subscribe(enqueue);
    removeNotificationHook = pi.events.on("notifications:prepare", (value) => {
      if (typeof value !== "object" || value === null || loadError) return;
      const draft = value as { event?: unknown; message?: string };
      if (draft.event !== "agent_settled") return;
      const running = (manager?.active() ?? []).filter((job) => job.running);
      if (!running.length) return;
      const ids = running.slice(0, 10).map(({ id }) => `[${id}]`).join(", ");
      const remaining = running.length > 10 ? `, +${running.length - 10} more` : "";
      draft.message = `Agent finished: Jobs running: ${ids}${remaining}.`;
    });
    const onExit = (): void => manager?.killAllSync();
    process.on("exit", onExit);
    removeExitHook = () => process.removeListener("exit", onExit);
    updateWidget();
  });

  pi.on("session_shutdown", () => {
    notificationMode = "none";
    removeOverviewHook?.();
    removeOverviewHook = undefined;
    removeNotificationHook?.();
    removeNotificationHook = undefined;
    stopWidgetRefresh();
    manager?.killAllSync();
    removeExitHook?.();
    removeExitHook = undefined;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    pending = [];
    history.clear();
    pendingBatches.clear();
    manager?.dispose();
    manager = undefined;
    ctxRef = undefined;
  });

  pi.registerTool({
    name: "bash_async",
    label: "Async Bash",
    description: "Run lengthy commands without blocking the agent, with automatic completion notifications. Do not poll.",
    promptSnippet: "Run lengthy commands without blocking the agent, with automatic completion notifications.",
    promptGuidelines: [
      "Always provide a short descriptive title stating the job's purpose, rather than copying a long command.",
      "Use bash_async for lengthy commands such as builds, test suites, and servers; reserve bash for quick commands. After starting a job, continue independent work or end your turn. Do not poll for completion; a completion message arrives automatically.",
      "Use bash_check only to inspect progress, bash_send to answer a prompt on stdin, and bash_kill to stop a job.",
    ],
    parameters: Type.Object({
      command: Type.String({ minLength: 1, description: "Shell command to execute." }),
      timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT, description: "Maximum execution time in seconds; must be positive. Defaults to 60." })),
      title: Type.String({ minLength: 1, pattern: "\\S", description: "Required short, descriptive job title shown instead of the command." }),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (typeof params.title !== "string" || !params.title.trim() || !jobLabel({ title: params.title, command: "" })) throw new Error("A visible, nonblank job title is required.");
      const { id: jobId, record } = await requireManager().start(params.command, params.timeout ?? DEFAULT_TIMEOUT, ctx.cwd, params.title);
      updateWidget();
      notifyChange("started", record.title ? `Job started: [${jobId}] ${record.title}` : `Job [${jobId}] started.`);
      return {
        content: [{ type: "text", text: `Job [${jobId}] started in background. Continue independent work or end your turn; completion will notify you automatically.` }],
        details: jobMetadata(jobId, record),
      };
    },
    renderCall(args, theme) {
      const timeout = args.timeout ?? DEFAULT_TIMEOUT;
      const suffix = `timeout ${timeout}s`;
      const label = args.title ? jobLabel({ title: args.title, command: "" }) : args.command ?? "...";
      return new Text(theme.fg("toolTitle", theme.bold(`$ ${label}`)) + theme.fg("muted", ` (${suffix}) [async]`), 0, 0);
    },
    renderResult: renderStartedResult,
  });

  pi.registerTool({
    name: "bash_check",
    label: "Check Job",
    description: "Report a background job's status (running or exited with its code) and the last lines of its log.",
    promptSnippet: "Inspect a background job's status and recent output.",
    parameters: Type.Object({
      id,
      tail_lines: Type.Optional(Type.Integer({ minimum: 1, description: `Number of log lines to return. Defaults to ${TAIL_LINES}.` })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_toolCallId, params) {
      const status = await requireManager().check(params.id, params.tail_lines ?? TAIL_LINES);
      return {
        content: [{ type: "text", text: formatStatus(status) }],
        details: { ...jobMetadata(params.id, status.record), status },
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("bash_check")) + (args.id ? theme.fg("accent", theme.bold(` [${args.id}]`)) : theme.fg("muted", " ...")), 0, 0);
    },
    renderResult,
  });

  pi.registerTool({
    name: "bash_send",
    label: "Send Input",
    description: "Write a line to a background job's stdin, for simple CLI prompts that do not need a full terminal.",
    promptSnippet: "Send a line of input to a background job.",
    parameters: Type.Object({
      id,
      input: Type.String({ description: "String to write to the process stdin, followed by a newline." }),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_toolCallId, params) {
      requireManager().send(params.id, params.input);
      notifyChange("input", `Input sent to job [${params.id}].`);
      return {
        content: [{ type: "text", text: `Input sent to job [${params.id}].` }],
        details: { id: params.id },
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("bash_send")) + (args.id ? theme.fg("accent", theme.bold(` [${args.id}]`)) : theme.fg("muted", " ...")), 0, 0);
    },
    renderResult,
  });

  pi.registerTool({
    name: "bash_kill",
    label: "Kill Job",
    description: "Terminate a background job's whole process group with SIGINT, escalating to SIGKILL after five seconds.",
    promptSnippet: "Stop a background job and its child processes.",
    parameters: Type.Object({ id }, { additionalProperties: false }),
    executionMode: "sequential",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async execute(_toolCallId, params) {
      const record = await requireManager().kill(params.id);
      updateWidget();
      notifyChange("terminated", `Job [${params.id}] terminated.`);
      return {
        content: [{ type: "text", text: `Job [${params.id}] terminated.` }],
        details: jobMetadata(params.id, record),
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("bash_kill")) + (args.id ? theme.fg("accent", theme.bold(` [${args.id}]`)) : theme.fg("muted", " ...")), 0, 0);
    },
    renderResult,
  });

  pi.registerCommand("jobs", {
    description: "Browse and expand background jobs, /jobs kill <id>, or /jobs kill-all",
    getArgumentCompletions(prefix) {
      const values = ["kill-all", ...(manager?.active() ?? []).flatMap(({ id }) => [id, `kill ${id}`])];
      return values.flatMap((value) => value.startsWith(prefix) ? [{ value, label: value }] : []);
    },
    async handler(args, ctx) {
      const value = args.trim();
      if (value === "kill-all") {
        const ids = (manager?.active() ?? []).map(({ id }) => id);
        for (const jobId of ids) {
          try {
            await manager?.kill(jobId);
            notifyChange("terminated", `Job [${jobId}] terminated.`);
          } catch {
            // Keep terminating the rest.
          }
        }
        updateWidget();
        ctx.ui.notify(ids.length ? `Terminated ${ids.length} job(s).` : "No background jobs.", "info");
        return;
      }
      if (value.startsWith("kill ")) {
        const jobId = value.slice(5).trim();
        try {
          const record = await requireManager().kill(jobId);
          updateWidget();
          notifyChange("terminated", `Job [${jobId}] terminated.`);
          ctx.ui.notify(`Job ${jobId} (PGID ${record.pgid}) terminated.`, "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (value) {
        ctx.ui.notify("Usage: /jobs [kill <id>|kill-all]", "error");
        return;
      }
      const active = manager?.active() ?? [];
      const items = await Promise.all([
        ...active.map(async ({ id, record, running }) => {
          let detail = formatMetadata(jobMetadata(id, record));
          try { detail += `\n\n${formatStatus(await requireManager().check(id))}`; }
          catch (error) { detail += `\nStatus unavailable: ${error instanceof Error ? error.message : String(error)}`; }
          return { title: formatJobLine(id, record.title ?? record.command, running, Math.max(0, Math.floor(Date.now() / 1000) - record.start_time)), detail };
        }),
        ...[...history.values()].reverse().map(async (completion) => ({
          title: formatJobLine(completion.id, completion.record.title ?? completion.record.command, false, completion.runtimeSeconds, jobOutcome(completion)),
          detail: `${formatMetadata(jobMetadata(completion.id, completion.record))}\n\n${formatStatus({ ...completion, running: false, tail: completion.tail ?? { text: "[No archived log preview is available; historical log paths may be reused.]", truncated: false } })}${pending.some((job) => completionKey(job) === completionKey(completion)) ? "\nAwaiting agent delivery." : ""}`,
          color: OUTCOME_COLORS[jobOutcome(completion)],
          background: outcomeBackground(jobOutcome(completion)),
        })),
      ]);
      if (ctx.mode !== "tui") { ctx.ui.notify(items.map((item) => item.title).join("\n") || "No background jobs.", "info"); return; }
      await ctx.ui.custom<void>((tui, theme, _keys, done) => createBrowser({
        title: "Jobs", items, theme, height: () => Math.max(1, tui.terminal.rows - 6),
        requestRender: () => tui.requestRender(), done,
      }));
    },
  });
}
