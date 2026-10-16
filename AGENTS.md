# Contributing to CleanSave

CleanSave is an MIT-licensed local media library built with TypeScript and
Node.js. These conventions apply to human contributors and coding agents.

## Working practices

- Read the affected source and tests before changing behavior. Make focused
  changes and preserve unrelated work and runtime data.
- Document public functions, classes, types, schemas, and methods with JSDoc.
  Explain intent, defaults, side effects, and meaningful failure behavior.
- Keep user instructions in README and `docs/quick-start.md` current. Do not add
  private investigation logs, approval histories, credentials, or machine-specific paths.
- Describe evidence honestly: offline fixtures, live platform access, and actual
  media playback establish different things. One working link is not platform-wide support.
- Do not publish, deploy, or change global agent configuration without authorization.
- Use subagents only when explicitly requested; this file does not request delegation.

## Toolchain and style

- Node.js 24, pnpm workspaces, strict TypeScript, ESM. Use the pinned package
  manager and lockfile. Keep browser code free of Node-only imports.
- Preserve `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and
  `useUnknownInCatchVariables`. Validate unknown boundary data with Zod.
- Avoid `any`, non-null assertions, unsafe casts, and unexplained lint suppressions.
- Two spaces, semicolons, single quotes, trailing commas, LF, UTF-8; use Prettier
  with the configured 100-column width. Separate logical declarations clearly.
- Prefer named exports, small functions, explicit dependencies, and explicit
  return types on public service functions. Use camelCase values, PascalCase
  types/components, and kebab-case ordinary filenames.
- Handle promises deliberately. Propagate cancellation and dispose streams,
  workers, browsers, sessions, and file handles. Redact unexpected errors.

## Architecture and invariants

- Backend services own resolution, downloads, records, and job state. REST and
  MCP share the same operations. The stdio adapter connects to a running backend;
  it never opens SQLite or creates a second worker. Explicit stdio service lifecycle
  tools may start/stop/restart the managed backend through its controller; reads and
  MCP connection initialization never start it. Recheck token scopes even while stopped.
- Keep platform adapters, public DTOs, persisted rows, and transient source access
  distinct. No platform-specific branches in generic file storage or React views.
- API creation defaults: `downloadContent=false`, `requireNoWatermark=false`.
  Reuse duplicate posts, preserve selected share parameters, and retain job intent.
- Web app saves and downloads always require watermark-free sources, including retries.
  Keep the watermark policy configurable for API/MCP callers without a UI toggle.
- Initial capture and successful explicit refresh append immutable timestamped
  counts. Duplicate pastes, idempotent replays, and download retries add no points.
  Replace other current source metadata only during explicit refresh; preserve
  first-capture time, annotations, pinned media identities, and completed files.
- Missing counts are null; rounded labels are not exact numbers. Store IDs and
  exact counts as strings, timestamps as UTC ISO-8601. Failed refreshes preserve
  previous metadata and count history.
- Preserve every primary album slot in order, even if unavailable. Covers and
  avatars cannot count as primary items or complete an album.
- SQLite is authoritative; manifests are derived. Use transactional claims,
  generation fencing, durable file adoption, and ordered migrations. Never hold
  a database transaction across network or filesystem I/O.
- Cancellation/deletion must fence late writes and file adoption. Destructive
  cleanup is not cancellable once requested. Reads never initiate media downloads.

## Security and licensing

- Bind to loopback and validate actual peer addresses, Host, and Origin. Default
  credential-free localhost access has full permissions across REST, media, and MCP.
  Require pairing/token authentication only when explicitly enabled. Supplied tokens
  always retain their scopes; invalid credentials must not fall back to local access.
- Treat all source data as untrusted. Validate HTTPS hosts, ports, DNS/public IPs,
  and every redirect. Do not forward credentials across origins. Browser recovery
  must enforce the same destination policy at connection time.
- Never persist or expose signed media URLs or anonymous visitor cookies in
  DTOs, manifests, MCP output, or logs. Keep tokens, raw share messages, runtime
  libraries, and downloaded content out of source control.
- Stream with backpressure and byte/time limits; validate media before adoption.
  Resolve owned files by internal IDs and enforce realpath containment.
- YouTube remains TypeScript/Node.js without mandatory external downloaders or
  media tools. Upstream player code executes only inside bounded QuickJS WASM
  in an isolated worker, without guest Node, filesystem, networking, or module loading.
  The owner process must not evaluate upstream JavaScript.
- No default telemetry, cloud uploads, personal browser profiles, or login-cookie import.
- Keep application source MIT; preserve third-party notices and fixture licenses.
  Downloaded media is not licensed by the project's software license.

## Verification

Run `pnpm verify` for formatting, lint, types, deterministic offline tests, and
production build. Run `pnpm test:e2e` when changing UI, HTTP/MCP, or media-serving
boundaries. Install its browser with `pnpm exec playwright install --with-deps chromium`.

Add meaningful regression coverage for changed behavior, especially duplicate
intent, counts and refresh preservation, cancellation/deletion, recovery,
auth/scopes, redirects, media validation, and pagination. Use temporary SQLite
libraries and synthetic or redistributable fixtures, never real credentials or
scraped personal data. Keep CI independent of social platform availability.

Run an isolated production-install smoke check when changing packaging or runtime
imports: deploy with `pnpm --filter cleansave deploy --prod --legacy /absolute/temp/package`,
then `node --import tsx scripts/package-smoke.ts /absolute/temp/package`.
Restore development dependencies with `pnpm install --prod=false` if needed.

Live checks are separate: explicitly set `CLEANSAVE_LIVE=1` and
`CLEANSAVE_LIVE_URL` before `pnpm test:live`; set `CLEANSAVE_LIVE_DOWNLOAD=1` only
when testing downloads. Use an isolated `CLEANSAVE_LIVE_DATA_DIR`. Do not broaden
live investigations beyond the requested task.

Before completion, inspect changes for private data and broken links, report the
observable fixes and checks actually run, and state material limitations.
