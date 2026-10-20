# Pi Async Jobs

A Pi extension for running long shell commands in the background without blocking the agent. It adds `bash_async`, `bash_check`, `bash_send`, and `bash_kill` tools, a running-jobs widget, a `/jobs` browser, and event-driven completion steering so the model is notified when work finishes instead of polling.

## Install

Requires Node 22.19 or newer and Pi. Tested against **Pi 1.2.0**; older Pi releases are not supported. Pi supplies the runtime libraries, so there is no separate build or dependency installation step.

```sh
pi install git:github.com/OscarCookeAbbott/pi-async-jobs
```

Before loading this update, wait for jobs in all Pi instances to finish; older versions can signal adopted foreign jobs during shutdown (see State and recovery). Then start a new session or run `/reload`. For a pinned release, append `@v0.9.0` to the source. Unpinned installs follow the repository's default branch when running `pi update --extensions`.

Use `pi install --local <source>` for a project-scoped installation; Pi loads it after project trust is granted. To uninstall:

```sh
pi remove git:github.com/OscarCookeAbbott/pi-async-jobs
```

Do not also keep a copied version under `~/.pi/agent/extensions/`: it would register the same tools twice. This package is distributed through Git; it is not published to npm yet.

## Why background jobs

A foreground `bash` call blocks the turn until the command finishes. `bash_async` starts the command in its own process group, returns immediately, and streams stdout and stderr to a log file. When the process exits, times out, or is killed, the extension delivers one completion message to the model. If the agent is idle, that message starts a turn; if a run is active, the message steers it. After starting a job, the agent should continue independent work or end its turn; completion wakes an idle agent automatically. The model does not need to poll.

## Agent tools

Each job gets a two-character ID (`00`–`zz`, 1,296 possible values) that is recycled once the job leaves the registry.

| Tool | Arguments | Behaviour |
| --- | --- | --- |
| `bash_async` | `command` and a required descriptive `title`; optional `timeout` (positive seconds, default 60) | Spawns a detached process group, writes the registry entry, and starts the log stream. Returns a compact acknowledgement and continuation/no-polling guidance to the agent. The TUI shows only the command and a bold blue `Job [<id>] started.`; expanding reveals the full command, not process/debug metadata. Inspect metadata with `/jobs`, `bash_check` or expanded completion messages |
| `bash_check` | `id`; optional `tail_lines` (default 50) | Reports `running` or the exit code and returns the last log lines |
| `bash_send` | `id`, `input` | Writes `input` plus a newline to the process stdin |
| `bash_kill` | `id` | Sends `SIGINT` to the process group, falling back to `SIGKILL` after a five-second grace period |

Every job has a finite timeout. `0`, negatives, fractions and values above 2,147,483 seconds (Node's timer limit, about 24.8 days) are rejected; omitting `timeout` uses 60 seconds. Legacy saved jobs with `timeout: 0` migrate to a 60-second deadline measured from their original start time, so already-overdue legacy jobs are terminated after reload.

Every new `bash_async` call requires a visible, nonblank descriptive `title`, for example `{ "command": "npm test", "title": "Run test suite", "timeout": 120 }`. The title replaces the command in primary tool headers, widget rows, lists and completion summaries. The command still executes unchanged and remains available in expanded debug metadata. Titles are persisted across reloads; older saved untitled jobs continue to display their command.

The tools run sequentially because they share the on-disk registry. Each command runs under the shell Pi resolves for the built-in bash tool, so it honours `settings.shellPath`; when that path is invalid the extension warns and uses the default shell.

## Completion steering

When a job finishes, the extension builds one frame per completion:

```text
Job [a1] succeeded (14s): npm test
Output [a1]:
17 tests passed.
```

Command labels are flattened and limited to 120 Unicode code points. Completion tails contain up to 20 lines and 4 KiB; `bash_check` defaults to 50 lines with the same byte limit. Successful command output is retained because it may be the requested result. Nonzero exits, signals, timeouts and unknown exit codes are distinguished. Unreadable logs produce an explicit warning rather than looking like silent output.

Merged model-facing frames are limited to 16 KiB, with status summaries ahead of log output. Very large frames explicitly flag omitted details and report unsuccessful/unknown totals. Failures, unavailable logs and truncation include log locations; `<id>.log` means the named job's ID. Full process metadata remains available in `/jobs` and expanded inspection/completion results, not start results. Expanding the TUI does not expand model context.

Completions that arrive during an active run or within the debounce window are collapsed into a single merged message, so several short jobs do not trigger a burst of model calls. The frame is queued with `triggerTurn` when the agent is idle and as a steer message when a run is active. Finished rows are removed only when Pi emits `message_end` for that exact completion frame, not when it is queued. Delivery IDs are distinct from recyclable job IDs, so an older or duplicate acknowledgement cannot clear a newer completion. Queue failures retain rows and warn; a subsequent completion retries the unsent entries.

## Widget and command

Async call headers retain Pi's native bold `$ title` presentation (or `$ command` for legacy untitled jobs), followed by a muted effective timeout and trailing `[async]` marker, e.g. `(timeout 60s) [async]`. Other job tools use bold names and bold-accented boxed job IDs. Start/input/termination acknowledgements and running status headings use pi-lens-style bold blue highlighting, without changing surrounding backgrounds. Start commands show a five-visual-line head preview, expandable independently of agent context; continuation instructions are agent-only. Log output uses the standard tool-output colour; invocation errors use the error colour. Completion notifications retain Pi's themed message background and configured output padding. Successful jobs use the semantic `toolSuccessBg` background and failed jobs use `toolErrorBg`, with normal foreground text, in thread status results, full views and both collapsed/expanded completion sections. The compact persistent widget instead uses semantic status foregrounds (success/error/warning), never outcome backgrounds. Mixed batches apply the appropriate background separately to each job. Normal foreground styling is retained; timeouts/signals keep their warning styling. This does not change tool result success/error semantics. Job output bodies collapse to the last five visual lines (including wrapped long lines), with Pi's configured tool-expansion key hint; status headings remain visible. Clicking a completion notification toggles that notification independently, while the tool-output shortcut still controls all messages together. Expanding inspection/completion views reveals retained output and process metadata; expanding a start result reveals only its full command and acknowledgement. Existing UI safety limits apply. This presentation is TUI-only and never truncates model feedback further.

- The widget shows `▶ [ab] 14s command`, with compact clocks (`14s`, `1:02`, `1:02:03`) ahead of command labels so long commands cannot hide the duration. It requests a redraw once per second while jobs run, without rebuilding the widget or sending model messages. Refreshes stop when no jobs are running, and never start in non-interactive modes.
- Finished jobs remain visible until their completion reaches the agent's context, using their recorded (non-increasing) runtime and distinct outcome markers and colours: `✓` success, `✗` failure, `⏱` timeout, `⚠` signal, and `?` unknown. Queued-but-not-consumed completions count as finished in the heading and remain visible while the agent is busy, then disappear once delivered.
- Command labels are single-line and stripped of terminal control sequences; each row fits the available terminal width. Multiline commands therefore cannot add unaccounted rows over the editor. The widget is hidden when there are neither running nor unnotified jobs.
- `/jobs` opens a snapshot browser of running jobs and session completion history, including jobs already delivered to the agent. ↑/↓ or Home/End selects; Enter/Space toggles full metadata and the bounded log tail; Page Up/Down scrolls expanded details and Escape closes. Fullscreen mouse row clicks, wheel scrolling and navigation buttons are supported; regular terminals keep native mouse/scrollback behaviour.
- `/jobs kill <id>` terminates one job.
- `/jobs kill-all` terminates every running job.

Commands work in all modes; the widget requires TUI mode.

The compact widget keeps at most six rows. Overflow is beside its header counts, e.g. `Jobs · 12 running · Showing 1-6/12`, with no extra footer row.

## Optional overview integration

When `pi-overview` is loaded, only currently running jobs appear in its Running jobs section, with no inline job-count badge. Titles replace primary labels; hover details include original command/process metadata, outcome, timeout and runtime, but no log contents. Finished jobs disappear from the menu immediately; completion history remains available in `/jobs` and the thread. Acknowledgement still controls removal from the persistent widget. History is restored from the current branch's saved completion messages on reload/tree changes and has no fixed list-count cutoff. Full views use the archived completion tail rather than rereading a historical log path that another job may have reused. Collection handles either extension load order, including headless sessions, without an overview dependency or changes to tool feedback.

## Optional desktop notifications

Job-change desktop notifications default to **off** and are separate from the agent-facing completion messages, which always remain enabled. `pi-notifications` is declared as an optional Git dependency; its absence or failure never prevents job execution. Load it once as a Pi package; dependency copies are not automatically registered:

```sh
pi install git:github.com/OscarCookeAbbott/pi-notifications
```

Configure in Pi settings and `/reload`:

```json
{
  "asyncJobs": { "notifications": "completed" }
}
```

`asyncJobs.notifications` accepts:

- `none` (default): no job-change desktop notifications.
- `started`: job starts only.
- `completed`: job completions, including failure, timeout, cancellation and unknown status.
- `all`: starts, completions, input sends and successful explicit termination, including `/jobs kill` and `/jobs kill-all`.

Events are `jobs.started`, `jobs.completed`, `jobs.input` and `jobs.terminated`, emitted through `notifications:notify`. Notification text includes only the job ID and status, never command text, input or log output. An explicit kill can notify both completion and termination because these report distinct changes. Reads, lists, restoration, streaming log writes, failed operations and shutdown cleanup do not notify. `notifications.events` can filter individual events further. Invalid settings warn and disable desktop notifications without affecting job control.

### Agent finished with jobs running

When `pi-notifications` sends its `agent_settled` notification, this extension replaces the default text with `Agent finished: Jobs running: [ab], [cd].` if any jobs are still alive. It uses the synchronous `notifications:prepare` hook, so there is only **one** notification and no dependency on extension registration order. With no running jobs, the default `Agent finished:` is unchanged.

This context is independent of `asyncJobs.notifications`: it works even when job-change notifications are `none`, but never enables a globally disabled or filtered notification. It includes up to ten live job IDs and a count of additional jobs, not potentially sensitive command text. Finished jobs awaiting their completion message are not counted. The hook is removed at session shutdown.

## State and recovery

Active metadata and logs are stored under `<jobs-root>/sessions/<SHA-256 of Pi session ID>/`, as `registry.json` and `<id>.log`. The root defaults to the system temporary directory's `pi_jobs` folder. Job IDs, monitoring, completion delivery and controls are scoped to that session, even when different sessions share a working directory. On session start the extension reads only its session's registry, re-attaches to surviving processes, and reaps dead entries. A corrupt registry or missing session identity fails closed instead of falling back to shared state. Concurrent writers to the same saved Pi session are not supported.

Legacy unscoped `registry.json` files and logs are left untouched and are never automatically adopted: their owning thread cannot be established safely. Before upgrading/reloading an older instance, allow jobs in all threads to finish; older versions may have adopted foreign jobs and can signal them during shutdown. Already-saved foreign completion messages are not removed from session history.

Set `PI_JOBS_DIR` to change the directory (used by the test suite). Set `PI_JOBS_DEBOUNCE_MS` to change the completion merge window (default 200).

## Safety

- **Process groups:** Jobs are started detached, so each PID is its own process-group leader. Timeouts, `bash_kill`, and shutdown cleanup signal the whole group (`-pgid`), which stops child processes such as node workers or test runners.
- **Model output cap:** Tail reads inspect at most 4 KiB, even for enormous single lines; UTF-8 text and merged notifications have additional byte bounds. Truncation is explicit and logs remain inspectable.
- **Log cap:** Each log file is capped at 10 MB. Writes stop at the cap and a truncation marker is appended, so a runaway output loop cannot fill the disk.
- **Shutdown cleanup:** A synchronous process-exit hook and the session-shutdown handler send `SIGKILL` only to active process groups in this session's registry.

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
