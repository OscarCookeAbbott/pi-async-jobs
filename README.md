# Pi Async Jobs

A Pi extension for running long shell commands in the background without blocking the agent. It adds `bash_async`, `bash_check`, `bash_send`, and `bash_kill` tools, a running-jobs widget, a `/jobs` browser, and event-driven completion steering so the model is notified when work finishes instead of polling.

## Install

Requires Node 22.19 or newer and Pi. Tested against **Pi 1.2.0**; older Pi releases are not supported. Pi supplies the runtime libraries, so there is no separate build or dependency installation step.

```sh
pi install git:github.com/OscarCookeAbbott/pi-async-jobs
```

Start a new session or run `/reload`. For a pinned release, append `@v0.1.0` to the source. Unpinned installs follow the repository's default branch when running `pi update --extensions`.

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
| `bash_async` | `command`; optional `timeout` (seconds, default 60, `0` for none) | Spawns a detached process group, writes the registry entry, and starts the log stream. Returns `Job <id> started (PID <pid>). Logging to <log_path>` |
| `bash_check` | `id`; optional `tail_lines` (default 50) | Reports `running` or the exit code and returns the last log lines |
| `bash_send` | `id`, `input` | Writes `input` plus a newline to the process stdin |
| `bash_kill` | `id` | Sends `SIGINT` to the process group, falling back to `SIGKILL` after a five-second grace period |

The tools run sequentially because they share the on-disk registry. Run each command through a shell as if it were a normal `bash` call.

## Completion steering

When a job finishes, the extension builds one frame per completion:

```text
[Background Job a1 finished with exit code 0 (runtime: 14s)]
Command: npm test
Log file: /tmp/pi_jobs/a1.log
Tail (last 20 lines):
...
```

Completions that arrive during an active run or within the debounce window are collapsed into a single merged message, so several short jobs do not trigger a burst of model calls. The frame is delivered with `triggerTurn` when the agent is idle and as a steer message when a run is active.

## Widget and command

- The widget lists running jobs with their IDs, commands, and runtimes. It is hidden when no jobs are running.
- `/jobs` lists running jobs.
- `/jobs kill <id>` terminates one job.
- `/jobs kill-all` terminates every running job.

Commands work in all modes; the widget requires TUI mode.

## State and recovery

Active metadata is stored as JSON at `/tmp/pi_jobs/registry.json` and logs at `/tmp/pi_jobs/<id>.log`. On session start the extension reads the registry, re-attaches to processes that are still alive, and reaps entries whose processes are gone, so a harness restart does not lose running jobs. When a Pi process shuts down cleanly, it kills every active process group. A corrupt registry fails closed: the tools refuse to run rather than overwriting durable state.

Set `PI_JOBS_DIR` to change the directory (used by the test suite). Set `PI_JOBS_DEBOUNCE_MS` to change the completion merge window (default 200).

## Safety

- **Process groups:** Jobs are started detached, so each PID is its own process-group leader. Timeouts, `bash_kill`, and shutdown cleanup signal the whole group (`-pgid`), which stops child processes such as node workers or test runners.
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
