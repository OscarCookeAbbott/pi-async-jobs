import type { JobCompletion, JobStatus } from "./jobs.ts";

export function formatCompletion(completion: JobCompletion, tail: string, tailLines: number): string {
  const status = completion.timedOut
    ? `timed out after ${completion.record.timeout}s`
    : `finished with exit code ${completion.exitCode ?? "unknown"}`;
  const lines = [
    `[Background Job ${completion.id} ${status} (runtime: ${completion.runtimeSeconds}s)]`,
    `Command: ${completion.record.command}`,
    `Log file: ${completion.record.log_path}`,
  ];
  if (tail.trim()) lines.push(`Tail (last ${tailLines} lines):`, tail);
  return lines.join("\n");
}

export function formatStatus(status: JobStatus): string {
  let header: string;
  if (status.running) {
    header = `Job ${status.id} running (PID ${status.record.pid}, runtime ${status.runtimeSeconds}s)`;
  } else if (status.timedOut) {
    header = `Job ${status.id} timed out (runtime ${status.runtimeSeconds}s)`;
  } else {
    header = `Job ${status.id} exited with code ${status.exitCode ?? "unknown"} (runtime ${status.runtimeSeconds}s)`;
  }
  const lines = [header, `Command: ${status.record.command}`, `Log: ${status.record.log_path}`];
  if (status.tail.trim()) lines.push("--- log tail ---", status.tail);
  return lines.join("\n");
}

export function formatJobLine(id: string, command: string, running: boolean, runtimeSeconds: number): string {
  return `${running ? "▶" : "…"} [${id}] ${command} (${runtimeSeconds}s)`;
}
