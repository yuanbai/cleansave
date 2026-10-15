# CleanSave quick start

This guide takes you from a source checkout to a working local library, then
connects an AI agent to that same library over MCP.

- [Install and run](#install-and-run)
- [Use the web app](#use-the-web-app)
- [Connect an agent with MCP](#connect-an-agent-with-mcp)
- [API tokens and permissions](#api-tokens-and-permissions)
- [Optional configuration](#optional-configuration)
- [Troubleshooting](#troubleshooting)

## Install and run

### 1. Install the prerequisites

Use **Node.js 24** and **pnpm 11.25.0**. Check Node, then install the project's
pinned package manager if necessary:

```sh
node --version
npm install --global pnpm@11.25.0
pnpm --version
```

The version output should start with `v24.` for Node and be `11.25.0` for pnpm.

### 2. Get the source and build it

Clone this repository using the URL from GitHub's **Code** menu, or download and
extract its source ZIP. Open a terminal in the `cleansave` directory containing
`package.json`, then run:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Installation needs registry access. The build compiles the backend and packages,
builds the static frontend, and prepares the CLI under `dist/`.

### 3. Start the local server

```sh
pnpm start
```

Leave this terminal running. CleanSave listens on `127.0.0.1:4777` and prints a
single-use pairing link. Open that complete link in your browser within five
minutes. Pairing establishes a private browser session and removes the secret
from the address bar.

The app is then available at `http://127.0.0.1:4777`. A plain URL alone cannot
pair a new browser. Restart the server for a fresh link if the old link has
expired or was already used. Browser sessions expire after 24 hours and on
server restart.

### 4. Know where your library lives

Without `--data-dir`, CleanSave uses:

| Operating system | Default data directory                                               |
| ---------------- | -------------------------------------------------------------------- |
| macOS            | `~/Library/Application Support/CleanSave`                            |
| Windows          | `%LOCALAPPDATA%\CleanSave`                                           |
| Linux            | `$XDG_DATA_HOME/cleansave`, or `~/.local/share/cleansave` when unset |

To choose another directory, stop the server with **Ctrl+C**, then start it with
an absolute path:

```sh
node dist/cli.js start --data-dir "/absolute/path/to/cleansave-library"
```

Use this same directory in every MCP or token command. Each directory is a
separate library, and only one backend may own a library at a time.

To back up a library, stop the backend and copy the **entire data directory**,
including SQLite, record files, and credentials. Keep that backup private. Restore
it with the backend stopped, then start with the restored directory.

## Use the web app

### Save a link or pasted share message

1. Click **Add link**.
2. Paste a URL or the full share message from Douyin, Xiaohongshu, Kuaishou,
   TikTok, or YouTube. Preserve share parameters, particularly for Xiaohongshu.
3. Leave **Download content** unchecked to capture metadata only, or check it to
   also download media. You can download later from the record.
4. Optionally check **Only sources marked watermark-free**. This requires source
   evidence; it does not remove watermarks or visually detect them. If no eligible
   source exists, metadata remains saved and the download reports a failure.
5. Click **Save record**. If multiple supported links were found, select the
   intended one and click **Save record** again.
6. The record opens while resolution runs. Follow progress on the record or in
   **Activity**. A queued job is not a completed download.

An identical paste reopens the existing record. Different share aliases for the
same post merge after resolution. Existing notes are preserved, with provisional
notes available as drafts when needed. Duplicate pastes do not refresh counts.

### Browse and play saved content

1. Open **Library** and choose grid or list view.
2. Search titles, descriptions, authors, notes, or tags. Filter by platform, media
   type, download state, or tag; choose newest or oldest first.
3. Open a record. Downloaded images appear in order, and saved videos have playback
   controls. Metadata-only records show placeholders.
4. Click **Download missing media** to fetch missing items. Completed items stay
   in place during retries. Retry a failed resolution from the record, or inspect
   and retry failed operations in **Activity**.
5. Use **Download content** below a retained item to save a copy through your
   browser. **Open original** opens the upstream post.

Browsing records never starts a primary media download. A partial album stays
partial until all expected primary items have been retained.

### Refresh metadata and inspect count history

1. Open a resolved record and click **Refresh metadata**.
2. Wait for the job to finish. Other source metadata updates to its newest
   version, while notes, tags, and retained files stay in place.
3. In **Counts over time**, choose likes, comments, shares, favorites, or views.
4. Choose all time, the last 7/30 days, or enter a custom start/end window and
   click **Apply window**. The end time is exclusive. Use **Load more** when shown.
5. Read the timestamped table alongside the chart. Missing counts display `—`;
   rounded labels remain marked as rounded. Chart lines break at those captures.

Each successful initial capture or explicit refresh stores its own timestamped
counts, including unchanged values. Counts can decrease. Failed refreshes keep
the previous metadata and observations visible. Download retries and duplicate
pastes add no count observations. Refreshing metadata does not download media.

### Notes, settings, and removal

- Edit **Personal notes** and comma-separated **Tags**, then click **Save notes &
  tags**. Refreshes preserve unsaved drafts. If another client changes the saved
  edits, review the conflict before replacing your draft with saved edits.
- Open **Settings** to choose English/Simplified Chinese, appearance, and defaults
  for new records. These preferences affect the frontend's save options.
- **Export metadata** saves the current public record as JSON.
- **Remove downloads** deletes the owned media files while keeping the record,
  notes, and count history. **Delete record** removes all of them. Review the
  confirmation before proceeding; cleanup cannot be cancelled after it is queued.
- **Activity** shows job progress and errors. Resolution, download, and refresh
  jobs can be cancelled; completed files and captured history are retained.

## Connect an agent with MCP

### 1. Keep the backend running

Complete the setup above first. The MCP process is a small stdio adapter to the
running server. It does **not** start another backend or open SQLite.

The default agent token is created automatically at
`<data-directory>/credentials/agent-token.txt`. The adapter reads it directly.
You do not need to copy the token into a chat or configuration file.

### 2. Find the absolute paths

From the source checkout, run:

```sh
node -p "process.execPath"
node -p "process.cwd() + '/dist/cli.js'"
```

Use the first output as the Node executable and the second as the CLI script.
Absolute paths are useful for GUI clients whose PATH differs from your shell.
Replace placeholders in the examples below. On Windows, JSON paths need escaped
backslashes (`C:\\path\\node.exe`) or forward slashes (`C:/path/node.exe`).

### 3. Configure Codex

Add this entry to your personal `~/.codex/config.toml`. Use a project-scoped
`.codex/config.toml` instead if you want it limited to a trusted project:

```toml
[mcp_servers.cleansave]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/cleansave/dist/cli.js", "mcp", "--base-url", "http://127.0.0.1:4777"]
```

If you started the backend with a custom data directory, add `"--data-dir"` and
that directory's absolute path to `args`. Use the backend's actual port in
`--base-url`.

Restart your Codex session after saving. Run `codex mcp list` to check registration,
and use `/mcp` in the CLI to inspect active servers. See the
[official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
for configuration locations and client setup.

### 4. Configure Claude Code

From the project where you want CleanSave available, run the following command
with your actual absolute paths:

```sh
claude mcp add --transport stdio --scope local cleansave -- "/absolute/path/to/node" "/absolute/path/to/cleansave/dist/cli.js" mcp --base-url http://127.0.0.1:4777
```

For a custom library, append `--data-dir "/absolute/path/to/cleansave-library"`.
Local scope keeps this entry private to you for that project. Restart the session,
run `claude mcp get cleansave`, and use `/mcp` inside Claude Code to check connection
status. See the [official Claude Code MCP guide](https://code.claude.com/docs/en/mcp)
for scopes and troubleshooting.

### 5. Configure another stdio MCP client

Merge an entry like this into your client's MCP configuration:

```json
{
  "mcpServers": {
    "cleansave": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/cleansave/dist/cli.js",
        "mcp",
        "--base-url",
        "http://127.0.0.1:4777"
      ]
    }
  }
}
```

Add the matching `--data-dir` arguments for a custom library. Configuration file
locations vary by client. Templates are also available in
[`integrations/`](../integrations/).

### 6. Verify the connection and use the tools

Ask your agent:

> Use CleanSave to show its capabilities and list up to 10 saved records.

This should call `get_capabilities` and `list_records`. An empty library should
return an empty list, rather than an authentication or connection error.

Then try a link you can access:

> Use CleanSave to save this link with downloadContent=false. Wait for resolution,
> show the saved metadata, and report any access error: YOUR_LINK

For downloads, ask explicitly:

> Download the missing media for that CleanSave record and check the final job
> and record state before reporting completion.

Useful tools:

| Tool                                     | Purpose                                                          |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `inspect_input`                          | Identify supported links without networking.                     |
| `save_media`                             | Save/reuse a record; returns record and job IDs.                 |
| `get_job`                                | Check progress, terminal status, and errors.                     |
| `list_records`, `get_record`             | Browse summaries and read full records.                          |
| `download_record`                        | Download missing media with an optional watermark policy.        |
| `refresh_metadata`, `list_count_history` | Capture a new observation and inspect the time series.           |
| `update_record`                          | Edit personal notes/tags with the current annotation revision.   |
| `get_media`                              | Read a retained asset descriptor; small images can be previewed. |
| `cancel_job`, `retry_job`                | Control eligible jobs without losing completed content.          |
| `remove_downloads`, `delete_record`      | Remove content with an additional delete permission.             |

The default token permits reading and writing, including resolution, downloads,
refreshes, and notes. It does not permit deletion or disclosure of local paths.
Content URLs also require authentication; descriptors are not public share links.
Optional workflow skills live in [`integrations/skills/`](../integrations/skills/).
MCP works without installing those skills or a plugin bundle.

## API tokens and permissions

The browser uses its paired session. Scripts use a bearer token in the
`Authorization` header. The stdio adapter uses the default private token file
unless `CLEANSAVE_TOKEN` is set in its process environment.

To create a separate token, run from the checkout:

```sh
node dist/cli.js token --name my-script --scopes read,write
```

The command prints the secret once. Store it privately. Include the same
`--data-dir` used by the backend when using a custom library. To revoke every
token with that name:

```sh
node dist/cli.js revoke --name my-script
```

Available scopes:

| Scope        | Allows                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------- |
| `read`       | Browse records/history, inspect jobs, read retained media and capabilities.                 |
| `write`      | Save, resolve, download, refresh metadata, edit annotations, manage eligible jobs/settings. |
| `delete`     | Remove downloads or delete records.                                                         |
| `local_path` | Request an absolute local path in a retained-file descriptor.                               |

Combine scopes explicitly when needed, for example `read,write,delete`. Revoking
an API token does not revoke paired browser sessions. Restarting the backend
invalidates browser sessions, but API tokens remain valid until revoked.

For HTTP MCP, connect to `http://127.0.0.1:4777/mcp` with bearer authentication.
It uses Streamable HTTP; `/api/v1/events` is the web app's event stream, not the MCP
endpoint. The authenticated REST schema is at `/api/v1/openapi.json`.

## Optional configuration

### A different port

```sh
node dist/cli.js start --port 4888
```

Use the printed pairing link and pass `--base-url http://127.0.0.1:4888` to the MCP
adapter. `CLEANSAVE_URL` is an alternative to `--base-url`.

### An explicit local proxy

If your network requires a proxy, configure a credential-free loopback HTTP
CONNECT endpoint you operate:

```sh
node dist/cli.js start --proxy http://127.0.0.1:8080 --proxy-platforms youtube,tiktok
```

Replace `8080` with your proxy's port. Direct networking is the default; ordinary
`HTTP_PROXY`/`HTTPS_PROXY` variables do not enable this mode. The proxy route uses
TLS-verified Cloudflare DNS-over-HTTPS and validated public-IP connections. The
DNS provider receives queried platform/CDN hostnames. TLS certificate checks stay
enabled. `CLEANSAVE_PROXY` and `CLEANSAVE_PROXY_PLATFORMS` provide the same options.

### Optional Douyin browser recovery

Some Douyin posts require the public player to load in Chromium. Point CleanSave
to an installed Chrome/Chromium executable:

```sh
node dist/cli.js start --browser-executable "/absolute/path/to/chrome"
```

`CLEANSAVE_BROWSER` is the equivalent environment variable. Recovery uses a fresh
isolated context and a controlled network gateway; it does not import your browser
profile or login cookies. No browser is downloaded automatically. YouTube does
not require this optional browser or any external downloader/media helper.

Include your existing `--data-dir` and other options when restarting with a new
configuration.

## Troubleshooting

| Symptom                                        | What to check                                                                                                                                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser asks you to connect                    | Open the complete pairing link printed by the current server. Restart for a fresh link if needed.                                                                                              |
| Port is in use                                 | Stop the other service or choose a different `--port`; update the MCP base URL too.                                                                                                            |
| Another backend owns the library               | Keep only one backend for that data directory. MCP must run the `mcp` command, not `start`.                                                                                                    |
| MCP cannot find Node or the script             | Use the absolute paths from step 2, build first, and restart the client.                                                                                                                       |
| MCP cannot connect                             | Keep the backend running and check the matching base URL/port. `GET /health` should return `{"status":"ok"}`.                                                                                  |
| MCP reports unauthorized                       | Check that it uses the same data directory, the token was not revoked, and no stale `CLEANSAVE_TOKEN` overrides the file.                                                                      |
| Missing token file                             | Start the backend once with the intended data directory before connecting MCP.                                                                                                                 |
| Permission denied for deletion or a local path | Use the paired web app, or explicitly grant the required additional API scopes.                                                                                                                |
| Platform refuses access                        | Open the original link to check availability. Private, removed, sign-in-gated, regional, and verification-gated content may be unavailable. Avoid repeatedly retrying a non-retryable refusal. |
| YouTube resolves but download fails            | Some static media URLs are refused with HTTP 403; unsupported streaming formats are reported separately. Retained metadata remains available.                                                  |
| Album is partial                               | Inspect the record/job error; **Download missing media** retries missing eligible items while preserving completed items.                                                                      |
| Build/native SQLite installation fails         | Confirm Node 24, install with the committed pnpm configuration, and use the platform's native build prerequisites if a prebuilt SQLite binary is unavailable.                                  |

For development checks and fixture requirements, read [AGENTS.md](../AGENTS.md).
