# CleanSave quick start

This guide takes you from a source checkout to a working local library, then
connects an AI agent to that same library over MCP.

- [Install and run](#install-and-run)
- [Install with an agent](#install-with-an-agent)
- [Run in the background](#run-in-the-background)
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

Clone the public repository, then build it:

```sh
git clone https://github.com/yuanbai/cleansave.git
cd cleansave
pnpm install --frozen-lockfile
pnpm build
```

Installation needs registry access. The build compiles the backend and packages,
builds the static frontend, and prepares the CLI under `dist/`.

### 3. Start the local server

```sh
pnpm start
```

Leave this terminal running and open [http://127.0.0.1:4777](http://127.0.0.1:4777/).
The backend accepts only localhost connections. By default, the app, API, and
HTTP MCP endpoint are available without a pairing link, cookie, or API token.
You can close and reopen your browser or restart the backend and use the same URL.

To require browser pairing or API tokens instead, enable the
[optional pairing mode](#optional-browser-pairing).

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

## Install with an agent

Paste this into Codex, Claude Code, Hermes, OpenClaw, or another local agent with
terminal access:

> Read https://raw.githubusercontent.com/yuanbai/cleansave/main/integrations/skills/cleansave-setup/SKILL.md and follow it to install and run CleanSave locally, then register its MCP server for my user account in this agent.

The [setup skill](../integrations/skills/cleansave-setup/SKILL.md) guides the agent
through cloning, prerequisite checks, a locked install and production build,
background startup, and user-scoped MCP registration. It reuses existing matching
installations and preserves libraries and other MCP servers. It needs Git,
Node 24, the pinned pnpm, network access for installation, and permission to run
local commands. A cloud-only sandbox cannot install on your computer.

The agent returns the actual browser URL, installation/library paths, service
commands, and whether MCP registration and tool calls were verified. You may
need to reload your agent or start a new session to load the tools. OpenClaw's
running Gateway can prevent native registry changes; the skill preserves the
conversation and reports the remaining registration step if a live change is
unavailable. Hermes/OpenClaw instructions follow their current native MCP CLIs;
check the installed version's help.

This flow does not install login or reboot autostart, alter global Node defaults,
import browser cookies, or download media during setup.

## Run in the background

After building, use these commands from the checkout:

```sh
node dist/cli.js service start
node dist/cli.js service status --verify-mcp
node dist/cli.js service stop
```

The start command returns after a detached backend is ready. It keeps running
after the terminal or setup agent exits. Starting it again reuses the same managed
backend. `service stop` closes jobs and SQLite before releasing library ownership;
it retains all saved records and files. After reboot, run `service start` again.
No OS service, login item, or scheduler is installed.

All three commands return JSON. Status includes the actual URL, library path,
private `service.log` location, and the absolute token-free `mcp` command and
arguments to use in your client. `--verify-mcp` performs real, read-only
`get_capabilities` and `list_records` calls through that stdio command.

For a custom library/port:

```sh
node dist/cli.js service start --data-dir "/absolute/library" --port 4888
node dist/cli.js service status --data-dir "/absolute/library" --verify-mcp
node dist/cli.js service stop --data-dir "/absolute/library"
```

Use absolute Node and CLI paths when invoking outside the checkout. Pass optional
proxy/browser flags on start just as for foreground operation. To change startup
options, stop the managed backend first, then start it with the desired options.
Existing starts are reused, not reconfigured. With pairing enabled, background logs
omit the browser pairing secret; use a foreground start for a fresh browser pairing
link. MCP still reads its own token file in either mode.

Service controls verify a private instance identity before stopping anything.
An existing foreground server or unrelated port occupant is not stopped or adopted;
stop that server in its own terminal or choose a free port. An unreachable managed
service is reported for inspection rather than killed by a saved PID. Keep
`service.json` and logs private; they are runtime files, not source files.

Before updating an installation, stop its backend, preserve any local source
changes, then update, install with the frozen lockfile, build, and start again.
Keep the same library path. Service startup does not fetch updates automatically.

## Use the web app

### Save a link or pasted share message

1. Click **Add link**.
2. Paste a URL or the full share message from Douyin, Xiaohongshu, Kuaishou,
   TikTok, or YouTube. Preserve share parameters, particularly for Xiaohongshu.
3. Leave **Download content** unchecked to capture metadata only, or check it to
   also download media. You can download later from the record.
4. Click **Save record**. If multiple supported links were found, select the
   intended one and click **Save record** again.
5. The record opens while resolution runs. Follow progress on the record or in
   **Activity**. A queued job is not a completed download.

Web app downloads always require sources identified as watermark-free, including
retries. This uses source evidence; it does not remove watermarks or visually detect
them. If no eligible source exists, metadata remains saved and the download reports
a failure. API and MCP callers can set `requireNoWatermark` independently.

An identical paste reopens the existing record. Different share aliases for the
same post merge after resolution. Existing notes are preserved, with provisional
notes available as drafts when needed. Duplicate pastes do not refresh counts.

### Browse and play saved content

1. Open **Library** and choose grid or list view.
2. Search titles, descriptions, authors, notes, or tags. Filter by platform, media
   type, download state, or tag; choose newest or oldest first.
3. Open a record. Downloaded images appear in order, and saved videos have playback
   controls. Metadata-only records show placeholders. Read the author, platform,
   saved date, and caption in **Post details**; use
   **Show more** to expand descriptions longer than four lines.
4. Click **Download missing media** to fetch missing items. This button is hidden
   when all media is downloaded. Completed items stay in place during retries.
   Retry a failed resolution from the record, or inspect
   and retry failed operations in **Activity**.
5. Use **Download content** below a retained item to save a copy through your
   browser. The URL in **Post details** opens the upstream post.

Browsing records never starts a primary media download. A partial album stays
partial until all expected primary items have been retained.

### Refresh metadata and inspect count history

1. Open a resolved record and click **Refresh metadata** in **Counts**.
2. Wait for the job to finish. Other source metadata updates to its newest
   version, while notes, tags, and retained files stay in place.
3. In **Counts over time**, choose likes, comments, shares, favorites, or views.
4. Choose **Last 7 days** or **Last 30 days** to apply a range and fill **From** and
   **Until** in your local time. **All time** clears both fields. For a custom range,
   edit either field; the dropdown changes to **Custom range** and the chart and
   table update automatically. Clear a field to remove that boundary; clearing both
   selects **All time**. The end time is exclusive and presets round it up to the next
   minute. If **From** is equal to or later than **Until**, a validation message appears and the
   chart and table keep the last valid range until you correct it. Use **Load more**
   when shown.
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
  for new records. Appearance, language, and the **Download content** default apply
  and save immediately when changed.
- **Export metadata** saves the current public record as JSON.
- **Download content** lists retained files with their size, format, and verification
  details. **Remove downloads** appears there when downloaded files exist.
  It deletes those files while keeping the record, notes, and count history.
  **Delete record**, in **Post details**, removes all of them. Review the
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

Register for your user account with the native CLI, using the actual paths:

```sh
codex mcp add cleansave -- "/absolute/path/to/node" "/absolute/path/to/cleansave/dist/cli.js" mcp --base-url http://127.0.0.1:4777 --data-dir "/absolute/library"
```

This preserves other servers in your personal configuration. If configuring
manually instead, merge this entry into `~/.codex/config.toml` (or the active
`CODEX_HOME` equivalent):

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

Register for your user account with your actual absolute paths:

```sh
claude mcp add --transport stdio --scope user cleansave -- "/absolute/path/to/node" "/absolute/path/to/cleansave/dist/cli.js" mcp --base-url http://127.0.0.1:4777 --data-dir "/absolute/library"
```

Use the same data directory as the backend. User scope makes the server available
across your projects, normally through `~/.claude.json`; the default `local` scope
would restrict it to the current project. Reload or restart the session,
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

For Hermes and OpenClaw, the setup skill includes focused instructions for their
[Hermes](../integrations/skills/cleansave-setup/references/hermes.md) and
[OpenClaw](../integrations/skills/cleansave-setup/references/openclaw.md) native
user-level registries. Preserve the selected profile and other entries.

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

The adapter supplies a read/write token for resolution, downloads, refreshes,
and notes. That token does not permit deletion or disclosure of local paths.
Default credential-free local requests have full access; enable optional pairing
to require authorization. Content URLs are local library addresses and require
a paired session or token only when pairing mode is enabled.
Optional workflow skills live in [`integrations/skills/`](../integrations/skills/).
MCP works without installing those skills or a plugin bundle.

## API tokens and permissions

By default, localhost requests need no credentials and have full library access.
Host and Origin checks remain active, and non-loopback connections are rejected.
When optional pairing is enabled, browsers need a paired session and scripts
need a bearer token in the `Authorization` header.

The stdio adapter supplies the default private read/write token unless
`CLEANSAVE_TOKEN` is set in its process environment. Explicitly supplied tokens
retain their configured scopes in both modes; invalid or revoked tokens are
rejected rather than falling back to credential-free access. Token scopes do not
restrict callers who omit credentials in the default local access mode.

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

For HTTP MCP, connect to `http://127.0.0.1:4777/mcp`. Supply a bearer token when
pairing mode is enabled, or optionally to use scoped access in the default mode.
It uses Streamable HTTP; `/api/v1/events` is the web app's event stream, not the MCP
endpoint. The REST schema is at `/api/v1/openapi.json`.

## Optional configuration

### Optional browser pairing

Pairing is disabled by default. To enable it explicitly:

```sh
node dist/cli.js start --require-pairing
```

Alternatively set `CLEANSAVE_REQUIRE_PAIRING=1` or `true` in the backend's process
environment. Unset it or use `0`/`false` to restore the default on the next start.
The CLI flag takes precedence over the environment variable.

In pairing mode, open the complete link printed in the terminal within five
minutes. It works once and creates a private browser session; the secret is
removed from the address bar. That session expires after 24 hours or on backend
restart. Restart for a fresh pairing link when needed. API and HTTP MCP callers
must provide a valid token instead. Both modes accept only localhost connections.

### A different port

```sh
node dist/cli.js start --port 4888
```

Open the printed local URL (or pairing link when enabled) and pass `--base-url http://127.0.0.1:4888` to the MCP
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
| Browser asks you to connect                    | Pairing is opt-in. If enabled, use the current terminal link or restart for a fresh one. For default access, restart without `--require-pairing` and unset `CLEANSAVE_REQUIRE_PAIRING`.        |
| Port is in use                                 | Stop the other service or choose a different `--port`; update the MCP base URL too.                                                                                                            |
| Another backend owns the library               | Keep only one backend for that data directory. MCP must run the `mcp` command, not `start`.                                                                                                    |
| Service is unreachable                         | Inspect the private log and instance state. Service controls refuse to stop a process whose identity cannot be verified; do not kill a PID copied from stale state.                            |
| MCP stopped working after reboot               | Run `service start` with the original library and port. Background mode does not install reboot autostart.                                                                                     |
| MCP cannot find Node or the script             | Use the absolute paths from step 2, build first, and restart the client.                                                                                                                       |
| MCP cannot connect                             | Keep the backend running and check the matching base URL/port. `GET /health` should return `{"status":"ok"}`.                                                                                  |
| MCP reports unauthorized                       | Check that it uses the same data directory, the token was not revoked, and no stale `CLEANSAVE_TOKEN` overrides the file.                                                                      |
| Missing token file                             | Start the backend once with the intended data directory before connecting MCP.                                                                                                                 |
| Permission denied for deletion or a local path | Explicitly supplied tokens stay scoped. Grant the needed scopes, or use the web app with the configured access mode.                                                                           |
| Platform refuses access                        | Open the original link to check availability. Private, removed, sign-in-gated, regional, and verification-gated content may be unavailable. Avoid repeatedly retrying a non-retryable refusal. |
| YouTube resolves but download fails            | Some static media URLs are refused with HTTP 403; unsupported streaming formats are reported separately. Retained metadata remains available.                                                  |
| Album is partial                               | Inspect the record/job error; **Download missing media** retries missing eligible items while preserving completed items.                                                                      |
| Build/native SQLite installation fails         | Confirm Node 24, install with the committed pnpm configuration, and use the platform's native build prerequisites if a prebuilt SQLite binary is unavailable.                                  |

For development checks and fixture requirements, read [AGENTS.md](../AGENTS.md).
