import { getShellConfig, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatCompletion, formatJobLine, formatStatus } from "./format.ts";
import { DEFAULT_TIMEOUT, JobManager, TAIL_LINES, tailFile, type JobCompletion, type JobRecord, type ShellCommand } from "./jobs.ts";

const COMPLETION_TAIL_LINES = 20;
const id = Type.String({ pattern: "^[0-9a-z]{2}$", description: "Two-character job ID" });
const details = (id: string, record: JobRecord) => ({ id, pid: record.pid, pgid: record.pgid, command: record.command, logPath: record.log_path });

export default function asyncJobsExtension(pi: ExtensionAPI): void {
  let manager: JobManager | undefined;
  let loadError: string | undefined;
  let ctxRef: ExtensionContext | undefined;
  let pending: JobCompletion[] = [];
  let flushTimer: NodeJS.Timeout | undefined;
  let removeExitHook: (() => void) | undefined;
  const debounceMs = Number(process.env.PI_JOBS_DEBOUNCE_MS ?? 200);

  function requireManager(): JobManager {
    if (loadError) throw new Error(`Async jobs registry is unavailable: ${loadError}`);
    if (!manager) throw new Error("Async jobs are not ready yet.");
    return manager;
  }

  async function logTail(path: string): Promise<string> {
    try {
      return await tailFile(path, COMPLETION_TAIL_LINES);
    } catch {
      return "";
    }
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

  function updateWidget(): void {
    const ctx = ctxRef;
    if (!ctx || ctx.mode !== "tui") return;
    const jobs = manager?.active() ?? [];
    if (!jobs.length) {
      ctx.ui.setWidget("async-jobs", undefined);
      return;
    }
    ctx.ui.setWidget("async-jobs", (_tui, theme) => ({
      render(width: number): string[] {
        const heading = truncateToWidth(theme.fg("muted", `Jobs · ${jobs.length} running · /jobs`), width);
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
    }));
  }

  async function flush(): Promise<void> {
    flushTimer = undefined;
    const batch = pending;
    pending = [];
    if (!batch.length) return;
    const rendered = await Promise.all(batch.map(async (completion) => formatCompletion(completion, await logTail(completion.record.log_path), COMPLETION_TAIL_LINES)));
    const content = rendered.join("\n\n");
    // Steer an active run; start a turn when the agent is idle. Either way the batch is one frame.
    pi.sendMessage({ customType: "async-jobs-completion", content, display: true }, ctxRef && !ctxRef.isIdle() ? { deliverAs: "steer" } : { triggerTurn: true });
    updateWidget();
  }

  function enqueue(completion: JobCompletion): void {
    pending.push(completion);
    if (!flushTimer) flushTimer = setTimeout(() => void flush().catch(() => {}), Number.isFinite(debounceMs) ? debounceMs : 200);
    updateWidget();
  }

  pi.on("session_start", async (_event, ctx) => {
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
    description: "Run a shell command in the background and return immediately. Output is streamed to a log file, and a completion message is delivered automatically; the agent must not poll. Use timeout 0 for no limit.",
    promptSnippet: "Start long-running shell commands in the background.",
    promptGuidelines: [
      "Use bash_async for long-running commands such as builds, test suites, and servers. Do not poll for completion; a completion message arrives automatically.",
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
        content: [{ type: "text", text: `Job ${jobId} started (PID ${record.pid}). Logging to ${record.log_path}` }],
        details: details(jobId, record),
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", "bash_async ") + theme.fg("muted", args.command), 0, 0);
    },
    renderResult(result, _options, theme) {
      const text = result.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
      return new Text(theme.fg("muted", text), 0, 0);
    },
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
        details: details(params.id, status.record),
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", "bash_check ") + theme.fg("muted", args.id), 0, 0);
    },
    renderResult(result, _options, theme) {
      const text = result.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
      return new Text(theme.fg("muted", text), 0, 0);
    },
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
        content: [{ type: "text", text: `Input sent to Job ${params.id}.` }],
        details: { id: params.id },
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", "bash_send ") + theme.fg("muted", args.id), 0, 0);
    },
    renderResult(result, _options, theme) {
      const text = result.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
      return new Text(theme.fg("muted", text), 0, 0);
    },
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
        content: [{ type: "text", text: `Job ${params.id} (PGID ${record.pgid}) terminated.` }],
        details: details(params.id, record),
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", "bash_kill ") + theme.fg("muted", args.id), 0, 0);
    },
    renderResult(result, _options, theme) {
      const text = result.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
      return new Text(theme.fg("muted", text), 0, 0);
    },
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
