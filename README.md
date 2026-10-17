# CleanSave

**A local media library for people and AI agents.** Paste a social link or share
message, capture its metadata, and choose whether to download the images or video.
Browse the same library in your browser, through the REST API, or with MCP tools.

[Quick start](docs/quick-start.md) · [Agent integrations](docs/quick-start.md#connect-an-agent-with-mcp) · [Contributing](AGENTS.md) · [MIT license](LICENSE)

## Install with your agent

Paste this into a local AI agent with terminal access, such as Codex, Claude Code,
Hermes, or OpenClaw:

> Read https://raw.githubusercontent.com/yuanbai/cleansave/main/integrations/skills/cleansave-setup/SKILL.md and follow it to install and run CleanSave locally, then register its MCP server for my user account in this agent.

The [setup skill](integrations/skills/cleansave-setup/SKILL.md) starts a background
service without login or reboot autostart; client reloads and prerequisites are
covered in the [quick-start guide](docs/quick-start.md#install-with-an-agent).

## Features

- **Save links and share messages.** Choose the intended link when a message contains several.
- **Download when you choose.** Save metadata first or download immediately; duplicate pastes reuse existing records.
- **Keep a local library.** Search and filter records, view retained images/videos, and add personal notes and tags.
- **Track counts over time.** Refresh metadata to append timestamped likes, comments, shares, favorites, and views when available. Other source metadata updates to its newest version.
- **Use agents and scripts.** The web app, typed TypeScript client, REST API, and MCP server share one backend and library.
- **Stay in control.** Localhost-only access, optional browser pairing, scoped API tokens, and no default telemetry or cloud upload.
- **Choose your interface.** English or Simplified Chinese; light, dark, or system appearance.
- **Check download storage.** Settings shows the total size and file count of completed downloads.

## Platforms

| Platform             | Images | Video   | Access and format notes                                                                                                                              |
| -------------------- | ------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Douyin / 抖音        | Yes    | Yes     | Public share pages; some posts need optional isolated Chromium recovery.                                                                             |
| Xiaohongshu / 小红书 | Yes    | Yes     | Preserve the full share link; share tokens can be required.                                                                                          |
| Kuaishou / 快手      | Yes    | Yes     | Public manifests and image albums with same-post alias matching.                                                                                     |
| TikTok               | Yes    | Yes     | Public hydration data; regional and verification restrictions can prevent access.                                                                    |
| YouTube              | —      | Limited | Static H.264/AAC MP4 or compatible tracks muxed in Node.js. Some media URLs return HTTP 403. SABR, HLS, DASH, DRM, and live streams are unsupported. |

Availability depends on the post, platform, and network. The app reports access
refusals and unsupported formats. YouTube uses TypeScript/Node.js libraries and
an isolated QuickJS WebAssembly worker, with no mandatory external downloader or
media-processing executable.

The web app always requires sources identified as watermark-free. API and MCP callers
can choose this policy with `requireNoWatermark`. It uses evidence from the source;
it does not remove watermarks or visually inspect downloaded media.

## Run locally

Install **Node.js 24** and **pnpm 11.25.0**, then run these commands from a source checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Open [http://127.0.0.1:4777](http://127.0.0.1:4777/). Localhost access works
without a pairing link or browser session by default, including after reopening
your browser or restarting the backend. Keep the server running while using the
app or MCP integration. Metadata-only saving is the default.

For background operation after building, use `node dist/cli.js service start`.
`node dist/cli.js service status --verify-mcp` checks the service and MCP connection;
`node dist/cli.js service stop` stops its backend. Start it again after reboot.
`node dist/cli.js service restart` reuses its saved startup settings.

To require browser pairing or an API token, start with `node dist/cli.js --require-pairing`
or set `CLEANSAVE_REQUIRE_PAIRING=1`. The terminal then prints a single-use pairing
link. Connections remain restricted to localhost in either mode.

See the [quick-start guide](docs/quick-start.md) for installation, web app
walkthrough, storage locations, optional network settings, and troubleshooting.

## Connect your agent

CleanSave includes a stdio MCP adapter for Codex, Claude Code, and other local MCP
clients. It connects to the running backend and reads a private token from the
same library directory. Library operations use that backend; the adapter never opens the database.

Tools include `save_media`, `list_records`, `get_record`, `download_record`,
`refresh_metadata`, `list_count_history`, `get_media`, and `get_storage_usage`. Saving returns job IDs;
agents should check actual completion before reporting downloaded content.

`get_storage_usage` takes no arguments and requires read access. It returns
`downloadBytes` (total completed download size in bytes) and `downloadedFiles`
(file count), using the same totals as Settings. Metadata, temporary files, and
files marked missing are excluded.

Follow the [step-by-step MCP setup](docs/quick-start.md#connect-an-agent-with-mcp).
Configuration examples and optional skills are in [integrations/](integrations/).
Agents using stdio MCP can explicitly inspect, start, stop, and restart a managed
background service with `get_service_status`, `start_service`, `stop_service`,
and `restart_service`. The MCP connection stays available while the backend is
stopped; lifecycle changes require write access and preserve the saved startup settings.
The stdio adapter uses a read/write token by default; its deletion and local-path
operations need additional scopes. Credential-free local callers have full access
when optional pairing is disabled.

## API and TypeScript client

The local API is available at `/api/v1`; its OpenAPI document is at
`/api/v1/openapi.json`. Streamable HTTP MCP is available at `/mcp`.

| Operation                   | Endpoint                                          |
| --------------------------- | ------------------------------------------------- |
| Inspect pasted input        | `POST /api/v1/inputs/inspect`                     |
| Save or reuse a record      | `POST /api/v1/records`                            |
| Browse / read records       | `GET /api/v1/records` · `GET /api/v1/records/:id` |
| Edit notes and tags         | `PATCH /api/v1/records/:id`                       |
| Refresh metadata and counts | `POST /api/v1/records/:id/metadata/refresh`       |
| Read count history          | `GET /api/v1/records/:id/counts/history`          |
| Download missing media      | `POST /api/v1/records/:id/downloads`              |
| Inspect a job               | `GET /api/v1/jobs/:id`                            |
| Read a retained file        | `GET /api/v1/assets/:id/content`                  |
| Read download storage usage | `GET /api/v1/storage`                             |

Both `downloadContent` and `requireNoWatermark` default to `false` when creating a
record. Download retries preserve captured metadata, count history, and completed
files. Explicit refreshes append an observation even when counts are unchanged;
missing counts remain unavailable and rounded labels remain rounded.

The package exposes a typed client through `cleansave/client`:

```ts
import { CleanSaveClient } from 'cleansave/client';

const client = new CleanSaveClient({ baseUrl: 'http://127.0.0.1:4777' });

const page = await client.list({ limit: 20 });
console.log(page.items);
```

See [API authentication](docs/quick-start.md#api-tokens-and-permissions)
for optional token handling and permissions. Explicitly supplied tokens retain
their configured scopes, and invalid tokens are rejected in both access modes.

## Development

The pnpm workspace contains a Fastify server, static React/Vite frontend,
Zod contracts, Kysely/SQLite persistence, platform resolvers, a typed client, and
MCP integrations. Source code uses strict TypeScript, ESM, ESLint, and Prettier.

```sh
pnpm dev                # API on 4777, frontend on 5173; open the printed local URL
pnpm verify             # Format, lint, types, offline tests, and production build
pnpm exec playwright install --with-deps chromium
pnpm test:e2e           # Browser and HTTP/stdio MCP workflows with synthetic media
```

Deterministic tests require no platform accounts or social network access. Live
checks are explicitly opted in; see [contributor instructions](AGENTS.md).

## License

CleanSave source is [MIT licensed](LICENSE). Dependencies retain their own
licenses; production builds include notices in `dist/notices/`. The software's
license does not grant rights to downloaded media.
