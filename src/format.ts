import { basename, dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import type { JobCompletion, JobRecord, JobStatus, LogTail } from "./jobs.ts";

export const MAX_COMPLETION_BYTES = 16 * 1024;
export interface CompletionFeedback { completion: JobCompletion; tail: LogTail }
export interface JobMetadata { id: string; pid: number; pgid: number; command: string; title?: string; logPath: string }

function commandLabel(command: string): string {
  const characters = Array.from(stripVTControlCharacters(command).replace(/\s+/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim());
  return characters.slice(0, 120).join("") + (characters.length > 120 ? "…" : "");
}

export function jobLabel(record: Pick<JobRecord, "command" | "title">): string {
  return commandLabel(record.title ?? record.command);
}

export type JobOutcome = "running" | "success" | "failure" | "timeout" | "signal" | "unknown";

export interface JobOutcomeInput {
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  running?: boolean;
}

export function jobOutcome(job: JobOutcomeInput): JobOutcome {
  if (job.running) return "running";
  if (job.timedOut) return "timeout";
  if (job.signal) return "signal";
  if (job.exitCode === 0) return "success";
  if (job.exitCode === null || job.exitCode === undefined) return "unknown";
  return "failure";
}

const OUTCOME_GLYPHS: Record<JobOutcome, string> = {
  running: "▶",
  success: "✓",
  failure: "✗",
  timeout: "⏱",
  signal: "⚠",
  unknown: "?",
};

export function formatJobSummary(job: JobCompletion | JobStatus, includeRuntime = true): string {
  const status = "running" in job && job.running ? "running"
    : job.timedOut ? `timed out after ${job.record.timeout}s`
    : job.signal ? `terminated (${job.signal})`
    : job.exitCode === 0 ? "succeeded"
    : job.exitCode === null ? "finished (exit unknown)"
    : `failed (exit ${job.exitCode})`;
  return `Job ${status}: [${job.id}] ${jobLabel(job.record)}${includeRuntime ? ` (${job.runtimeSeconds}s)` : ""}`;
}

function output(id: string, tail: LogTail): string {
  if (tail.error) return `Output [${id}] unavailable (${tail.error}).`;
  if (!tail.text && !tail.truncated) return "";
  return `Output [${id}]${tail.truncated ? " (truncated)" : ""}:\n${tail.text}`;
}

function needsLog(job: JobCompletion | JobStatus, tail: LogTail): boolean {
  const running = "running" in job && job.running;
  return tail.truncated || !!tail.error || (!running && (job.exitCode !== 0 || job.timedOut || !!job.signal));
}

export function formatCompletions(jobs: readonly CompletionFeedback[]): string {
  if (!jobs.length) return "";
  const unsuccessful = jobs.filter(({ completion: job }) => job.timedOut || job.signal || (job.exitCode !== null && job.exitCode !== 0)).length;
  const unknown = jobs.filter(({ completion: job }) => job.exitCode === null && !job.signal && !job.timedOut).length;
  const heading = jobs.length > 1 ? `${jobs.length} jobs finished (${unsuccessful} unsuccessful, ${unknown} unknown).\n` : "";
  const directories = [...new Set(jobs.map(({ completion }) => dirname(completion.record.log_path)))];
  const locations = jobs.length > 1 && jobs.every(({ completion: job }) => basename(job.record.log_path) === `${job.id}.log`)
    ? directories.map((dir) => join(dir, "<id>.log")).join("; ")
    : jobs.map(({ completion: job }) => `[${job.id}] ${job.record.log_path}`).join("\n");
  const logs = truncateHead(`Logs: ${locations}`, { maxBytes: 4096, maxLines: 1000 });
  const notice = "[Completion details truncated; inspect the listed log files.]";
  const budget = MAX_COMPLETION_BYTES - Buffer.byteLength(heading + logs.content + notice) - 8;
  // Keep statuses ahead of output so a verbose job cannot bury later failures.
  const headers = truncateHead(jobs.map(({ completion }) => formatJobSummary(completion)).join("\n"), { maxBytes: Math.floor(budget / 2), maxLines: 10000 });
  const tails = truncateHead(jobs.map(({ completion, tail }) => output(completion.id, tail)).filter(Boolean).join("\n\n"), { maxBytes: budget - Buffer.byteLength(headers.content), maxLines: 10000 });
  const truncated = headers.truncated || tails.truncated;
  const showLogs = truncated || jobs.some(({ completion, tail }) => needsLog(completion, tail));
  return [heading.trimEnd(), headers.content, tails.content, showLogs ? logs.content : "", truncated || (showLogs && logs.truncated) ? notice : ""].filter(Boolean).join("\n");
}

export function formatStatus(status: JobStatus, options: { includeRuntime?: boolean } = {}): string {
  return [formatJobSummary(status, options.includeRuntime !== false), output(status.id, status.tail), needsLog(status, status.tail) ? `Log: ${status.record.log_path}` : ""].filter(Boolean).join("\n");
}

export function formatJobDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

export function formatMetadata(metadata: JobMetadata): string {
  return `Job: [${metadata.id}] ${jobLabel(metadata)}\nPID ${metadata.pid} · PGID ${metadata.pgid}\nLog: ${metadata.logPath}\nCommand:\n${metadata.command}`;
}

export function formatJobLine(id: string, command: string, running: boolean, runtimeSeconds: number, outcome: JobOutcome = running ? "running" : "unknown"): string {
  const minutes = Math.floor(runtimeSeconds / 60);
  const seconds = String(runtimeSeconds % 60).padStart(2, "0");
  let duration = `${runtimeSeconds}s`;
  if (minutes >= 60) duration = `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${seconds}`;
  else if (minutes) duration = `${minutes}:${seconds}`;
  const status: Record<JobOutcome, string> = { running: "running", success: "succeeded", failure: "failed", timeout: "timed out", signal: "terminated", unknown: "finished" };
  return `${OUTCOME_GLYPHS[outcome]} Job ${status[outcome]} (${duration}): [${id}] ${commandLabel(command)}`;
}

export function jobMetadata(id: string, record: JobRecord): JobMetadata {
  return { id, pid: record.pid, pgid: record.pgid, command: record.command, ...(record.title === undefined ? {} : { title: record.title }), logPath: record.log_path };
}
