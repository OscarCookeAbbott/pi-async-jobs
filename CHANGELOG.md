# Changelog

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
