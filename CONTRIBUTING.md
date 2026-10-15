# Contributing

Open an issue with a reproducible example before proposing a substantial behaviour change. Include your Pi version, Node version, operating system, and expected and actual results. Remove credentials and personal session contents from reports.

## Development

Use Node 22.19 or newer. From the repository root:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Pi and its host libraries are pinned development dependencies; no global Pi installation, model credentials, or network access is needed to run the tests after dependency installation. Keep the peer dependencies host-provided: do not move them into runtime dependencies or bundle them.

Tests start real short-lived child processes and isolate state through a temporary `PI_JOBS_DIR`, so they never touch `/tmp/pi_jobs`. Keep new tests deterministic: prefer waiting on a completion event or a bounded condition over arbitrary sleeps.

Run `npm pack --dry-run` before changing packaging. It runs the checks and tests and lists the publishable files. The explicit `pi.extensions` entry loads only `src/index.ts`; tests and development configuration are not shipped.

Keep changes focused. Preserve existing behaviour when restructuring code, and cover changed observable behaviour with deterministic, isolated tests.

## Releases

Update `version` in `package.json` and `package-lock.json`, add a changelog entry, run the checks, and tag the release as `v<version>`. Git installations pinned to a tag remain pinned. The npm scope is provisional package metadata; registry availability and ownership must be confirmed before publishing.
