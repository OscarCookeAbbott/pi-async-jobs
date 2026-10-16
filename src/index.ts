import { getShellConfig, keyText, truncateHead, truncateToVisualLines, type ExtensionAPI, type ExtensionContext, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatCompletions, formatJobLine, formatMetadata, formatStatus, jobMetadata, type CompletionFeedback, type JobMetadata } from "./format.ts";
import { DEFAULT_TIMEOUT, JobManager, TAIL_LINES, tailFile, type JobCompletion, type ShellCommand } from "./jobs.ts";

const COMPLETION_TAIL_LINES = 20;
const id = Type.String({ pattern: "^[0-9a-z]{2}$", description: "Two-character job ID" });
const uiText = (text: string): string => {
  const shown = truncateHead(text, { maxLines: 500, maxBytes: 30000 });
  return shown.content + (shown.truncated ? "\n[Details truncated; inspect the log file for full output.]" : "");
};
function outputPreview(text: string, expanded: boolean, theme: Theme): Component {
  if (expanded) return new Text(text, 0, 0);
  let lastWidth: number | undefined;
  let cached: string[] = [];
  return {
    render(width) {
      if (width < 1) return [];
      if (width !== lastWidth) {
        const preview = truncateToVisualLines(text, 5, width, 0, "end");
        const key = keyText("app.tools.expand");
        const hint = theme.fg("muted", `... (${preview.skippedCount} earlier lines; ${key ? `${key} to expand` : "expand for full output"})`);
        cached = preview.skippedCount ? [truncateToWidth(hint, width), ...preview.visualLines] : preview.visualLines;
        lastWidth = width;
      }
      return cached;
    },
    invalidate() { lastWidth = undefined; },
  };
}

const renderResult: NonNullable<ToolDefinition["renderResult"]> = (result, { expanded }, theme, context) => {
  const text = result.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
  const metadata = result.details as JobMetadata | undefined;
  const color = context?.isError ? "error" : "toolOutput";
  const [heading, ...body] = uiText(text).split("\n");
  const component = new Container();
  component.addChild(new Text(theme.fg(color, heading!), 0, 0));
  if (body.length) component.addChild(outputPreview(theme.fg(color, body.join("\n")), expanded, theme));
  if (expanded && typeof metadata?.command === "string") component.addChild(new Text(theme.fg("muted", uiText(formatMetadata(metadata))), 0, 0));
  return component;
};

export default function asyncJobsExtension(pi: ExtensionAPI): void {
  let manager: JobManager | undefined;
  let loadError: string | undefined;
  let ctxRef: ExtensionContext | undefined;
  let pending: JobCompletion[] = [];
  let flushTimer: NodeJS.Timeout | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;
  let requestWidgetRender: (() => void) | undefined;
  let removeExitHook: (() => void) | undefined;
  const debounceMs = Number(process.env.PI_JOBS_DEBOUNCE_MS ?? 200);

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

  function updateWidget(): void {
    const ctx = ctxRef;
    if (!ctx || ctx.mode !== "tui") {
      stopWidgetRefresh();
      return;
    }
    const jobs = manager?.active() ?? [];
    if (!jobs.length) {
      stopWidgetRefresh();
      ctx.ui.setWidget("async-jobs", undefined);
      return;
    }
    ctx.ui.setWidget("async-jobs", (tui, theme) => {
      requestWidgetRender = () => tui.requestRender();
      return {
        render(width: number): string[] {
          const heading = truncateToWidth(theme.fg("muted", `Jobs · ${jobs.length} running`), width);
          const now = Math.floor(Date.now() / 1000);
          return [
            heading,
            ...jobs.slice(0, 6).map(({ id, record, running }) =>
              truncateToWidth(theme.fg(running ? "accent" : "warning", formatJobLine(id, record.command, running, Math.max(0, now - record.start_time))), width),
            ),
            ...(jobs.length > 6 ? [truncateToWidth(theme.fg("dim", `+${jobs.length - 6} more`), width)] : []),
          ];
        },
        invalidate() {},
      };
    });
    if (!refreshTimer) {
      refreshTimer = setInterval(() => requestWidgetRender?.(), 1000);
      refreshTimer.unref?.();
    }
  }

  async function flush(): Promise<void> {
    flushTimer = undefined;
    const batch = pending;
    pending = [];
    if (!batch.length) return;
    const jobs = await Promise.all(batch.map(async (completion) => ({ completion, tail: await tailFile(completion.record.log_path, COMPLETION_TAIL_LINES) })));
    const content = formatCompletions(jobs);
    // Steer an active run; start a turn when the agent is idle. Either way the batch is one frame.
    pi.sendMessage({ customType: "async-jobs-completion", content, display: true, details: { jobs } }, ctxRef && !ctxRef.isIdle() ? { deliverAs: "steer" } : { triggerTurn: true });
    updateWidget();
  }

  function enqueue(completion: JobCompletion): void {
    pending.push(completion);
    if (!flushTimer) flushTimer = setTimeout(() => void flush().catch(() => {}), Number.isFinite(debounceMs) ? debounceMs : 200);
    updateWidget();
  }

  pi.registerMessageRenderer<{ jobs: CompletionFeedback[] }>("async-jobs-completion", (message, { expanded, outputPad }, theme) => {
    const content = typeof message.content === "string" ? message.content : message.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
    const text = expanded && message.details?.jobs
      ? message.details.jobs.map(({ completion, tail }) => `${formatMetadata(jobMetadata(completion.id, completion.record))}\n${formatStatus({ ...completion, running: false, tail })}`).join("\n\n")
      : content;
    const box = new Box(outputPad ?? 1, 1, (line) => theme.bg("customMessageBg", line));
    let heading = true;
    const headings: string[] = [];
    const body: string[] = [];
    uiText(text).split("\n").forEach((line, index) => {
      if (index > 0 && !/^Job \[[0-9a-z]{2}\] /.test(line)) heading = false;
      if (heading) headings.push(theme.fg("toolTitle", theme.bold(line)));
      else body.push(theme.fg("customMessageText", line));
    });
    box.addChild(new Text(headings.join("\n"), 0, 0));
    if (body.length) box.addChild(outputPreview(body.join("\n"), expanded, theme));
    return box;
  });

  pi.on("session_start", async (_event, ctx) => {
    stopWidgetRefresh();
    ctxRef = ctx;
    manager?.dispose();
    manager = new JobManager(undefined, { shell: resolveShell(ctx) });
    loadError = undefined;
    try {
      const { restored, reaped } = await manager.load();
      if (restored.length) ctx.ui.notify(`Async jobs: re-attached to ${restored.join(", ")}.`, "info");
      else if (reaped.length) ctx.ui.notify(`Async jobs: cleaned up ${reaped.length} stale job(s).`, "info");
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Async jobs registry failed to load: ${loadError}`, "error");
    }
    manager.subscribe(enqueue);
    const onExit = (): void => manager?.killAllSync();
    process.on("exit", onExit);
    removeExitHook = () => process.removeListener("exit", onExit);
    updateWidget();
  });

  pi.on("session_shutdown", () => {
    stopWidgetRefresh();
    manager?.killAllSync();
    removeExitHook?.();
    removeExitHook = undefined;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    pending = [];
    manager?.dispose();
    manager = undefined;
    ctxRef = undefined;
  });

  pi.registerTool({
    name: "bash_async",
    label: "Async Bash",
    description: "Run lengthy commands without blocking the agent, with automatic completion notifications. Output is streamed to a log file; the agent must not poll. Use timeout 0 for no limit.",
    promptSnippet: "Run lengthy commands without blocking the agent, with automatic completion notifications.",
    promptGuidelines: [
      "Use bash_async for lengthy commands such as builds, test suites, and servers; reserve bash for quick commands. After starting a job, continue independent work or end your turn. Do not poll for completion; a completion message arrives automatically.",
      "Use bash_check only to inspect progress, bash_send to answer a prompt on stdin, and bash_kill to stop a job.",
    ],
    parameters: Type.Object({
      command: Type.String({ minLength: 1, description: "Shell command to execute." }),
      timeout: Type.Optional(Type.Integer({ minimum: 0, description: "Maximum execution time in seconds; 0 means unconstrained. Defaults to 60." })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { id: jobId, record } = await requireManager().start(params.command, params.timeout ?? DEFAULT_TIMEOUT, ctx.cwd);
      updateWidget();
      return {
        content: [{ type: "text", text: `Job [${jobId}] started in background. Continue independent work, or end your turn; completion will notify you automatically.` }],
        details: jobMetadata(jobId, record),
      };
    },
    renderCall(args, theme) {
      const timeout = args.timeout ?? DEFAULT_TIMEOUT;
      const suffix = timeout === 0 ? "no timeout" : `timeout ${timeout}s`;
      return new Text(theme.fg("toolTitle", theme.bold(`$ ${args.command ?? "..."}`)) + theme.fg("muted", ` (${suffix}) [async]`), 0, 0);
    },
    renderResult,
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
    description: "List background jobs, /jobs kill <id>, or /jobs kill-all",
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
      ctx.ui.notify(active.length ? active.map(({ id, record, running }) => formatJobLine(id, record.command, running, Math.max(0, Math.floor(Date.now() / 1000) - record.start_time))).join("\n") : "No background jobs.", "info");
    },
  });
}
