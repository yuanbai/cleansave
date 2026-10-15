# CleanSave

**A local media library for people and AI agents.** Paste a social link or share
message, capture its metadata, and choose whether to download the images or video.
Browse the same library in your browser, through the REST API, or with MCP tools.

[Quick start](docs/quick-start.md) · [Agent integrations](docs/quick-start.md#connect-an-agent-with-mcp) · [Contributing](AGENTS.md) · [MIT license](LICENSE)

## Features

- **Save links and share messages.** Choose the intended link when a message contains several.
- **Download when you choose.** Save metadata first or download immediately; duplicate pastes reuse existing records.
- **Keep a local library.** Search and filter records, view retained images/videos, and add personal notes and tags.
- **Track counts over time.** Refresh metadata to append timestamped likes, comments, shares, favorites, and views when available. Other source metadata updates to its newest version.
- **Use agents and scripts.** The web app, typed TypeScript client, REST API, and MCP server share one backend and library.
- **Stay in control.** Loopback binding, browser pairing, scoped API tokens, and no default telemetry or cloud upload.
- **Choose your interface.** English or Simplified Chinese; light, dark, or system appearance.

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

The optional watermark-free setting uses evidence from the source. It does not
remove watermarks or visually inspect downloaded media.

## Run locally

Install **Node.js 24** and **pnpm 11.25.0**, then run these commands from a source checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Open the **single-use pairing link printed in your terminal**. The app and API
run at `http://127.0.0.1:4777`. Keep the server running while using the browser or
MCP integration. Metadata-only saving is the default.

See the [quick-start guide](docs/quick-start.md) for installation, web app
walkthrough, storage locations, optional network settings, and troubleshooting.

## Connect your agent

CleanSave includes a stdio MCP adapter for Codex, Claude Code, and other local MCP
clients. It connects to the running backend and reads a private token from the
same library directory. It does not start another backend or open another database.

Tools include `save_media`, `list_records`, `get_record`, `download_record`,
`refresh_metadata`, `list_count_history`, and `get_media`. Saving returns job IDs;
agents should check actual completion before reporting downloaded content.

Follow the [step-by-step MCP setup](docs/quick-start.md#connect-an-agent-with-mcp).
Configuration examples and optional skills are in [integrations/](integrations/).
The default agent token grants read/write access; deleting records or exposing
local file paths requires additional scopes.

## API and TypeScript client

The authenticated API is available at `/api/v1`; its OpenAPI document is at
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

Both `downloadContent` and `requireNoWatermark` default to `false` when creating a
record. Download retries preserve captured metadata, count history, and completed
files. Explicit refreshes append an observation even when counts are unchanged;
missing counts remain unavailable and rounded labels remain rounded.

The package exposes a typed client through `cleansave/client`:

```ts
import { CleanSaveClient } from 'cleansave/client';

const token = process.env.CLEANSAVE_TOKEN;
if (!token) throw new Error('Set CLEANSAVE_TOKEN to your private API token.');

const client = new CleanSaveClient({ baseUrl: 'http://127.0.0.1:4777', token });

const page = await client.list({ limit: 20 });
console.log(page.items);
```

See [API authentication](docs/quick-start.md#api-tokens-and-permissions)
for token handling and permissions.

## Development

The pnpm workspace contains a Fastify server, static React/Vite frontend,
Zod contracts, Kysely/SQLite persistence, platform resolvers, a typed client, and
MCP integrations. Source code uses strict TypeScript, ESM, ESLint, and Prettier.

```sh
pnpm dev                # API on 4777, frontend on 5173; use the printed pairing link
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
