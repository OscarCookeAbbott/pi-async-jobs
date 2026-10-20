# Changelog

## 0.8.0

- Require a visible, nonblank descriptive title for every new bash_async call, in both schema and execution guards; retain legacy untitled-record fallbacks.
- Show only currently running jobs in the menu, with no inline count or completed-history rows; /jobs history and widget/thread delivery semantics remain unchanged.
- Publish typed running-job content for native command/detail cards.

## 0.7.0

- Keep persistent widget status foreground colours; reserve outcome backgrounds for thread results/full inspection, not compact rows.
- Retain session completion history in overview and `/jobs` after acknowledgement, with full process/command/outcome metadata and no list-count cutoff.
- Restore current-branch history from real Pi custom-message entries and preserve archived log previews so reused paths cannot show another job's output.

## 0.6.0

- Require finite positive timeouts (default 60 seconds), bounded to Node's timer range; migrate legacy unlimited jobs to original-start-time 60-second deadlines.
- Add optional persisted titles replacing command labels while retaining original commands in expanded metadata.
- Add selectable `/jobs` views with Enter/Space expansion, full metadata/bounded log tails, paging and fullscreen mouse/navigation buttons; put compact overflow beside header counts.
- Use semantic error/success backgrounds, not red/green foreground text, for finished jobs; style each job independently in mixed batches.
- Publish optional per-instance overview counts and job rows, retaining finished jobs until their matching agent-delivery acknowledgement.

## 0.5.2

- Use semantic error colouring for failed completion headers, expanded failure output and failed-process bash_check results, preserving mixed-batch success styling.
- Retain completed widget rows until Pi consumes the matching completion frame, rather than dropping them when steering is queued. Track unique frame IDs, ignore duplicate/foreign acknowledgements and retain rows after queue failures.
- Freeze finished-job runtimes while awaiting delivery and keep existing UI output limits.

## 0.5.1

- Use a colon after `Agent finished` in running-job notification summaries.

## 0.5.0

- Replace the agent-settled notification with live running-job IDs through notifications:prepare, without sending a second notification or requiring job-change notifications to be enabled.
- Scope the preparation hook to the session lifecycle, exclude finished jobs and command text, and use pi-notifications v0.2.0 as the optional dependency.

## 0.4.0

- Add opt-in desktop notifications for job starts, completions, input sends and explicit termination, with asyncJobs.notifications modes none (default), started, completed and all.
- Declare pi-notifications as an optional Git dependency; absent or broken notification consumers do not affect job control or agent-facing completion steering.

## 0.3.6

- Keep finished jobs in the widget until their completion notification is delivered, with distinct markers and colours for success, failure, timeout, signal and unknown outcomes.
- Toggle completion notifications by clicking them, independently of the global tool-output shortcut.

## 0.3.5

- Clear completion and cached-result state when reusing a job ID so new jobs can finalize, notify and leave the registry normally, including after a timeout.
- Add deterministic regression coverage for failures, timeouts and successes sharing the same recycled ID.

## 0.3.4

- Explicitly tell the agent to continue independent work or end its turn after starting a background job, both in launch feedback and prompt guidance; completion notifications remain automatic.

## 0.3.3

- Restore the native bold $ command header with muted effective timeout and trailing [async] marker.
- Make job-ID arguments bold as well as accented; keep incomplete placeholders muted.
- Collapse output bodies to five visual lines with Pi's expansion-key hint in tool results and completion notifications, preserving status headers and unchanged model content.

## 0.3.2

- Show the actual bash_async tool name in bold, accent shell commands and job IDs, and retain muted timeout/placeholder styling without a redundant async badge.
- Use bold, high-contrast notification headings, including batched statuses, while leaving subsequent log text in the body style.

## 0.3.1

- Lead tool descriptions and prompt summaries with non-blocking execution and automatic notifications; reserve bash for quick commands in agent guidance.
- Bold every tool header and show placeholders instead of undefined IDs during streaming.
- Restore themed completion-notification backgrounds and respect configured output padding.

## 0.3.0

- Use compact job acknowledgements and bounded command labels; retain command output and distinguish failed, signalled, timed-out and unknown exits.
- Bound log-tail reads and UTF-8 output to 4 KiB and merged model notifications to 16 KiB, with explicit truncation, log locations and unreadable-log warnings.
- Preserve full commands/process metadata in expanded TUI results and completion messages; use built-in-style shell headers, effective timeout suffixes and standard output/error colours.
- Refresh concise running-job clocks once per second through TUI redraw requests, with durations before long command labels and no model messages or widget rebuilds.
- Keep widget rows single-line and strip terminal control sequences to prevent command text corrupting editor layout; remove the redundant `/jobs` header hint.
- Finish registry persistence before notifying completion listeners and exit waiters, preventing stale-registry observations and cleanup races.

## 0.2.0

- Jobs run under the shell Pi resolves for the built-in bash tool, honouring `shellPath`. An invalid path warns and falls back to the default shell.

## 0.1.0

- Initial standalone Git release of the background job tools and `/jobs` interface.
- `bash_async`, `bash_check`, `bash_send`, and `bash_kill` with base-36 job IDs and process-group termination.
- Event-driven completion steering with per-batch merging, plus a running-jobs widget.
- Disk-backed registry with restart recovery and a 10 MB per-log cap.
