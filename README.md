# Pi Async Jobs

A Pi extension for running long shell commands in the background without blocking the agent. It adds `bash_async`, `bash_check`, `bash_send`, and `bash_kill` tools, a running-jobs widget, a `/jobs` browser, and event-driven completion steering so the model is notified when work finishes instead of polling.

## Install

Requires Node 22.19 or newer and Pi. Tested against **Pi 1.2.0**; older Pi releases are not supported. Pi supplies the runtime libraries, so there is no separate build or dependency installation step.

```sh
pi install git:github.com/OscarCookeAbbott/pi-async-jobs
```

Start a new session or run `/reload`. For a pinned release, append `@v0.3.2` to the source. Unpinned installs follow the repository's default branch when running `pi update --extensions`.

Use `pi install --local <source>` for a project-scoped installation; Pi loads it after project trust is granted. To uninstall:

```sh
pi remove git:github.com/OscarCookeAbbott/pi-async-jobs
```

Do not also keep a copied version under `~/.pi/agent/extensions/`: it would register the same tools twice. This package is distributed through Git; it is not published to npm yet.

## Why background jobs

A foreground `bash` call blocks the turn until the command finishes. `bash_async` starts the command in its own process group, returns immediately, and streams stdout and stderr to a log file. When the process exits, times out, or is killed, the extension delivers one completion message to the model. If the agent is idle, that message starts a turn; if a run is active, the message steers it. The model does not need to poll.

## Agent tools

Each job gets a two-character ID (`00`–`zz`, 1,296 possible values) that is recycled once the job leaves the registry.

| Tool | Arguments | Behaviour |
| --- | --- | --- |
| `bash_async` | `command`; optional `timeout` (seconds, default 60, `0` for none) | Spawns a detached process group, writes the registry entry, and starts the log stream. Returns `Job [<id>] started.`; PID, process group, full command and log path remain in expanded TUI details |
| `bash_check` | `id`; optional `tail_lines` (default 50) | Reports `running` or the exit code and returns the last log lines |
| `bash_send` | `id`, `input` | Writes `input` plus a newline to the process stdin |
| `bash_kill` | `id` | Sends `SIGINT` to the process group, falling back to `SIGKILL` after a five-second grace period |

The tools run sequentially because they share the on-disk registry. Each command runs under the shell Pi resolves for the built-in bash tool, so it honours `settings.shellPath`; when that path is invalid the extension warns and uses the default shell.

## Completion steering

When a job finishes, the extension builds one frame per completion:

```text
Job [a1] succeeded (14s): npm test
Output [a1]:
17 tests passed.
```

Command labels are flattened and limited to 120 Unicode code points. Completion tails contain up to 20 lines and 4 KiB; `bash_check` defaults to 50 lines with the same byte limit. Successful command output is retained because it may be the requested result. Nonzero exits, signals, timeouts and unknown exit codes are distinguished. Unreadable logs produce an explicit warning rather than looking like silent output.

Merged model-facing frames are limited to 16 KiB, with status summaries ahead of log output. Very large frames explicitly flag omitted details and report unsuccessful/unknown totals. Failures, unavailable logs and truncation include log locations; `<id>.log` means the named job's ID. Full commands and process metadata remain available in expanded TUI results and completion messages. Expanding the TUI does not expand model context.

Completions that arrive during an active run or within the debounce window are collapsed into a single merged message, so several short jobs do not trigger a burst of model calls. The frame is delivered with `triggerTurn` when the agent is idle and as a steer message when a run is active.

## Widget and command

Async call headers show the bold `bash_async` name, an accented `$ command`, and a muted effective timeout suffix, e.g. `(timeout 60s)` or `(no timeout)`. Other job tools use bold names and accented boxed job IDs. Output uses the standard tool-output colour; invocation errors use the error colour. Completion notifications use bold, high-contrast status headings above normally styled output, retaining Pi's themed message background and configured output padding. This styling is TUI-only.

- The widget shows `▶ [ab] 14s command`, with compact clocks (`14s`, `1:02`, `1:02:03`) ahead of command labels so long commands cannot hide the duration. It requests a redraw once per second while jobs run, without rebuilding the widget or sending model messages. Refreshes stop when the list empties or the session shuts down/restarts, and never start in non-interactive modes.
- Command labels are single-line and stripped of terminal control sequences; each row fits the available terminal width. Multiline commands therefore cannot add unaccounted rows over the editor. The widget is hidden when no jobs are running.
- `/jobs` lists running jobs.
- `/jobs kill <id>` terminates one job.
- `/jobs kill-all` terminates every running job.

Commands work in all modes; the widget requires TUI mode.

## State and recovery

Active metadata is stored as JSON at `/tmp/pi_jobs/registry.json` and logs at `/tmp/pi_jobs/<id>.log`. On session start the extension reads the registry, re-attaches to processes that are still alive, and reaps entries whose processes are gone, so a harness restart does not lose running jobs. When a Pi process shuts down cleanly, it kills every active process group. A corrupt registry fails closed: the tools refuse to run rather than overwriting durable state.

Set `PI_JOBS_DIR` to change the directory (used by the test suite). Set `PI_JOBS_DEBOUNCE_MS` to change the completion merge window (default 200).

## Safety

- **Process groups:** Jobs are started detached, so each PID is its own process-group leader. Timeouts, `bash_kill`, and shutdown cleanup signal the whole group (`-pgid`), which stops child processes such as node workers or test runners.
- **Model output cap:** Tail reads inspect at most 4 KiB, even for enormous single lines; UTF-8 text and merged notifications have additional byte bounds. Truncation is explicit and logs remain inspectable.
- **Log cap:** Each log file is capped at 10 MB. Writes stop at the cap and a truncation marker is appended, so a runaway output loop cannot fill the disk.
- **Shutdown cleanup:** A synchronous process-exit hook and the session-shutdown handler send `SIGKILL` to every active process group.

## Development

From the repository root:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run
```

Tests use the pinned local Pi development dependencies plus real short-lived child processes; they need no model, network, credentials, or personal session files. CI runs on Node 22.19 and 24.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and release guidance, and [CHANGELOG.md](CHANGELOG.md) for releases.

## Licence

[MIT](LICENSE).
