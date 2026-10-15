# Changelog

## 0.2.0

- Jobs run under the shell Pi resolves for the built-in bash tool, honouring `shellPath`. An invalid path warns and falls back to the default shell.

## 0.1.0

- Initial standalone Git release of the background job tools and `/jobs` interface.
- `bash_async`, `bash_check`, `bash_send`, and `bash_kill` with base-36 job IDs and process-group termination.
- Event-driven completion steering with per-batch merging, plus a running-jobs widget.
- Disk-backed registry with restart recovery and a 10 MB per-log cap.
