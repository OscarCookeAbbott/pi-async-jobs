import { truncateTail } from "@earendil-works/pi-coding-agent";
import { randomBytes, createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_TIMEOUT = 60;
export const MAX_LOG_BYTES = 10 * 1024 * 1024;
export const TAIL_LINES = 50;
export const MAX_TAIL_BYTES = 4096;
export const ID_COUNT = 36 * 36;
export const FINISHED_CACHE_SIZE = 32;

export interface JobRecord {
  pid: number;
  pgid: number;
  command: string;
  log_path: string;
  start_time: number;
  timeout: number;
}

export interface Registry {
  [id: string]: JobRecord;
}

export interface JobCompletion {
  id: string;
  record: JobRecord;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  runtimeSeconds: number;
}

export interface FinishedJob {
  record: JobRecord;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  runtimeSeconds: number;
}

export interface LogTail {
  text: string;
  truncated: boolean;
  error?: string;
}

export interface JobStatus extends JobCompletion {
  running: boolean;
  tail: LogTail;
}

export interface ShellCommand {
  shell: string;
  args: string[];
  transport?: "argv" | "stdin";
}

export interface JobManagerOptions {
  maxLogBytes?: number;
  shell?: ShellCommand;
}
export type CompletionListener = (completion: JobCompletion) => void;

const DEFAULT_SHELL: ShellCommand = { shell: "sh", args: ["-c"] };

export const defaultJobsDir = (): string => process.env.PI_JOBS_DIR ?? join(tmpdir(), "pi_jobs");

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function allocateId(registry: Registry, seed = randomBytes(16).toString("hex")): string {
  const used = Object.keys(registry).length;
  if (used >= ID_COUNT) throw new Error(`All ${ID_COUNT} two-character job IDs are in use.`);
  const start = createHash("sha256").update(seed).digest().readUInt32BE(0) % ID_COUNT;
  for (let offset = 0; offset < ID_COUNT; offset++) {
    const id = ((start + offset) % ID_COUNT).toString(36).padStart(2, "0");
    if (!(id in registry)) return id;
  }
  throw new Error("Job ID space exhausted.");
}

export function parseRegistry(value: unknown): Registry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Job registry must be a JSON object.");
  const registry: Registry = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[0-9a-z]{2}$/.test(id)) throw new Error(`Invalid job ID ${id} in registry.`);
    const record = entry as Partial<JobRecord>;
    if (
      typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0 ||
      typeof record.pgid !== "number" || typeof record.command !== "string" ||
      typeof record.log_path !== "string" || typeof record.start_time !== "number" ||
      typeof record.timeout !== "number"
    ) {
      throw new Error(`Invalid registry entry for job ${id}.`);
    }
    registry[id] = {
      pid: record.pid,
      pgid: record.pgid,
      command: record.command,
      log_path: record.log_path,
      start_time: record.start_time,
      timeout: record.timeout,
    };
  }
  return registry;
}

/** Reads only a bounded suffix, even when the log contains a single enormous line. */
export async function tailFile(path: string, lines: number): Promise<LogTail> {
  if (lines <= 0) return { text: "", truncated: false };
  try {
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      const position = Math.max(0, size - MAX_TAIL_BYTES);
      const buffer = Buffer.allocUnsafe(Math.min(size, MAX_TAIL_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      let start = 0;
      if (position > 0) while (start < bytesRead && (buffer[start] & 0xc0) === 0x80) start++;
      const parts = buffer.subarray(start, bytesRead).toString("utf8").split("\n");
      if (parts.at(-1) === "") parts.pop();
      const shown = truncateTail(parts.slice(-lines).join("\n"), { maxLines: lines, maxBytes: MAX_TAIL_BYTES });
      return { text: shown.content, truncated: shown.truncated || position > 0 || parts.length > lines };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { text: "", truncated: false, error: (error as NodeJS.ErrnoException).code ?? "read failed" };
  }
}

export class JobManager {
  readonly dir: string;
  readonly registryPath: string;
  readonly maxLogBytes: number;
  readonly shell: ShellCommand;
  private registry: Registry = {};
  private readonly children = new Map<string, ChildProcess>();
  private readonly restored = new Set<string>();
  private readonly timedOut = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly finished = new Map<string, FinishedJob>();
  private readonly listeners = new Set<CompletionListener>();
  private readonly exitWaiters = new Map<string, Array<() => void>>();
  private readonly timeoutTimers = new Map<string, NodeJS.Timeout>();
  private readonly logStreams = new Map<string, WriteStream>();
  private readonly stdinClosed = new Set<string>();
  private pollTimer?: NodeJS.Timeout;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(dir = defaultJobsDir(), options: JobManagerOptions = {}) {
    this.dir = dir;
    this.registryPath = join(dir, "registry.json");
    this.maxLogBytes = options.maxLogBytes ?? MAX_LOG_BYTES;
    this.shell = options.shell ?? DEFAULT_SHELL;
  }

  subscribe(listener: CompletionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  active(): Array<{ id: string; record: JobRecord; running: boolean }> {
    return Object.entries(this.registry).map(([id, record]) => ({ id, record, running: isAlive(record.pid) }));
  }

  get(id: string): JobRecord | undefined {
    return this.registry[id];
  }

  /** Reads the persisted registry, re-attaches to survivors, and reaps dead PIDs. */
  async load(): Promise<{ restored: string[]; reaped: string[] }> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    let raw: unknown = {};
    try {
      raw = JSON.parse(await readFile(this.registryPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const stored = parseRegistry(raw);
    const restored: string[] = [];
    const reaped: string[] = [];
    for (const [id, record] of Object.entries(stored)) {
      if (isAlive(record.pid)) {
        this.registry[id] = record;
        this.restored.add(id);
        restored.push(id);
      } else {
        reaped.push(id);
      }
    }
    if (reaped.length) await this.save();
    this.startPolling();
    return { restored, reaped };
  }

  async start(command: string, timeout = DEFAULT_TIMEOUT, cwd?: string): Promise<{ id: string; record: JobRecord }> {
    if (!command.trim()) throw new Error("Command must not be empty.");
    if (!Number.isInteger(timeout) || timeout < 0) throw new Error("Timeout must be a non-negative integer.");
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const id = allocateId(this.registry);
    const logPath = join(this.dir, `${id}.log`);
    const startTime = Math.floor(Date.now() / 1000);

    // The tool's contract is to run a shell command, so a shell is required. The shell is the one Pi
    // resolved for the user (settings.shellPath). Detached mode makes the child a process-group
    // leader, which is what lets termination reach its descendants.
    const fromStdin = this.shell.transport === "stdin";
    const child = spawn(this.shell.shell, fromStdin ? this.shell.args : [...this.shell.args, command], {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
    });
    if (!child.pid) {
      child.kill("SIGKILL");
      throw new Error("Failed to start the background process.");
    }
    if (fromStdin) {
      this.stdinClosed.add(id);
      child.stdin?.end(command);
    }
    const record: JobRecord = { pid: child.pid, pgid: child.pid, command, log_path: logPath, start_time: startTime, timeout };
    this.registry[id] = record;
    this.children.set(id, child);
    this.attachLog(id, child);

    child.on("error", () => this.finalize(id, null, null));
    child.stdin?.on("error", () => {});
    // "close" (not "exit") guarantees stdout and stderr have been fully delivered before the log is sealed.
    child.on("close", (code, signal) => {
      this.flush(id, child, () => this.finalize(id, code, signal));
    });

    try {
      await this.save();
    } catch (error) {
      this.terminate(record, "SIGKILL");
      delete this.registry[id];
      this.children.delete(id);
      this.completed.add(id);
      throw error;
    }
    if (timeout > 0) {
      this.timeoutTimers.set(id, setTimeout(() => this.onTimeout(id), timeout * 1000));
    }
    return { id, record };
  }

  async check(id: string, tailLines = TAIL_LINES): Promise<JobStatus> {
    const active = this.registry[id];
    if (active) {
      const running = this.children.has(id) || isAlive(active.pid);
      return {
        id,
        record: active,
        running,
        exitCode: null,
        signal: null,
        timedOut: this.timedOut.has(id),
        runtimeSeconds: Math.max(0, Math.floor(Date.now() / 1000) - active.start_time),
        tail: await tailFile(active.log_path, tailLines),
      };
    }
    const finished = this.finished.get(id);
    if (!finished) throw new Error(`Unknown job ${id}.`);
    return {
      id,
      record: finished.record,
      running: false,
      exitCode: finished.exitCode,
      signal: finished.signal,
      timedOut: finished.timedOut,
      runtimeSeconds: finished.runtimeSeconds,
      tail: await tailFile(finished.record.log_path, tailLines),
    };
  }

  send(id: string, input: string): void {
    const child = this.children.get(id);
    if (!child || !this.registry[id]) throw new Error(`Job ${id} has no attached stdin (not started by this process).`);
    if (this.stdinClosed.has(id)) throw new Error(`Job ${id} receives its command on stdin; bash_send is unavailable.`);
    if (!child.stdin || child.stdin.destroyed) throw new Error(`Job ${id} is not accepting input.`);
    child.stdin.write(`${input}\n`);
  }

  /** SIGINT, then SIGKILL after a five-second grace period, targeting the process group. */
  async kill(id: string): Promise<JobRecord> {
    const record = this.registry[id];
    if (!record) throw new Error(`Unknown job ${id}.`);
    this.terminate(record, "SIGINT");
    if (!(await this.waitForExit(id, 5000))) this.terminate(record, "SIGKILL");
    if (!(await this.waitForExit(id, 1000))) throw new Error(`Job ${id} did not terminate.`);
    return record;
  }

  /** Synchronous best-effort kill of every active process group, for process-exit cleanup. */
  killAllSync(): void {
    for (const record of Object.values(this.registry)) this.terminate(record, "SIGKILL");
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    for (const timer of this.timeoutTimers.values()) clearTimeout(timer);
    this.timeoutTimers.clear();
    this.listeners.clear();
  }

  private attachLog(id: string, child: ChildProcess): void {
    let stream: WriteStream;
    try {
      stream = createWriteStream(join(this.dir, `${id}.log`), { flags: "w", mode: 0o600 });
    } catch {
      return;
    }
    stream.on("error", () => {});
    let bytes = 0;
    let capped = false;
    const write = (chunk: Buffer): void => {
      if (capped) return;
      const remaining = this.maxLogBytes - bytes;
      if (chunk.length >= remaining) {
        if (remaining > 0) stream.write(chunk.subarray(0, remaining));
        bytes = this.maxLogBytes;
        capped = true;
        stream.write(`\n[log truncated at ${this.maxLogBytes} bytes]\n`);
        return;
      }
      bytes += chunk.length;
      stream.write(chunk);
    };
    child.stdout?.on("data", write);
    child.stderr?.on("data", write);
    this.logStreams.set(id, stream);
  }

  private flush(id: string, child: ChildProcess, done: () => void): void {
    const stream = this.logStreams.get(id);
    if (!stream) {
      done();
      return;
    }
    this.logStreams.delete(id);
    child.stdout?.removeAllListeners("data");
    child.stderr?.removeAllListeners("data");
    stream.end(done);
  }

  private onTimeout(id: string): void {
    const record = this.registry[id];
    if (!record) return;
    this.timedOut.add(id);
    this.terminate(record, "SIGKILL");
  }

  private terminate(record: JobRecord, signal: NodeJS.Signals): void {
    try {
      process.kill(-record.pgid, signal);
    } catch {
      try {
        process.kill(record.pid, signal);
      } catch {
        // Already gone.
      }
    }
  }

  private finalize(id: string, exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (this.completed.has(id)) return;
    const record = this.registry[id];
    if (!record) return;
    this.completed.add(id);
    const timer = this.timeoutTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timeoutTimers.delete(id);
    }
    delete this.registry[id];
    this.children.delete(id);
    this.restored.delete(id);
    this.stdinClosed.delete(id);
    const timedOut = this.timedOut.delete(id);
    const runtimeSeconds = Math.max(0, Math.floor(Date.now() / 1000) - record.start_time);
    const finished: FinishedJob = { record, exitCode, signal, timedOut, runtimeSeconds };
    this.finished.set(id, finished);
    if (this.finished.size > FINISHED_CACHE_SIZE) {
      const oldest = this.finished.keys().next().value;
      if (oldest !== undefined) this.finished.delete(oldest);
    }
    const waiters = this.exitWaiters.get(id) ?? [];
    this.exitWaiters.delete(id);
    const completion: JobCompletion = { id, record, exitCode, signal, timedOut, runtimeSeconds };
    // Completion must not race its registry update or a caller's cleanup of the jobs directory.
    void this.save().catch(() => {}).then(() => {
      for (const waiter of waiters) waiter();
      for (const listener of this.listeners) {
        try {
          listener(completion);
        } catch {
          // A listener must not break completion handling.
        }
      }
    });
  }

  private waitForExit(id: string, timeoutMs: number): Promise<boolean> {
    if (!this.registry[id]) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout;
      const wait = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.exitWaiters.set(id, [...(this.exitWaiters.get(id) ?? []), wait]);
      timer = setTimeout(() => {
        const waiters = this.exitWaiters.get(id);
        if (waiters) this.exitWaiters.set(id, waiters.filter((item) => item !== wait));
        resolve(false);
      }, timeoutMs);
    });
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.poll(), 500);
    this.pollTimer.unref?.();
  }

  private poll(): void {
    for (const id of [...this.restored]) {
      const record = this.registry[id];
      if (!record) {
        this.restored.delete(id);
        continue;
      }
      if (record.timeout > 0 && Math.floor(Date.now() / 1000) - record.start_time >= record.timeout) {
        this.timedOut.add(id);
        this.terminate(record, "SIGKILL");
      }
      if (!isAlive(record.pid)) this.finalize(id, null, null);
    }
  }

  private save(): Promise<void> {
    const next = this.saveChain.then(() => this.writeRegistry());
    this.saveChain = next.catch(() => {});
    return next;
  }

  private async writeRegistry(): Promise<void> {
    const temp = `${this.registryPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temp, JSON.stringify(this.registry, null, 2), { mode: 0o600 });
    await rename(temp, this.registryPath);
  }
}
