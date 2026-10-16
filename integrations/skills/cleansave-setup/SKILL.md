---
name: cleansave-setup
description: Install CleanSave locally, start its background service, and register its MCP server for the current user's Codex, Claude Code, Hermes, or OpenClaw agent. Use for initial setup or repairing that installation.
---

# Set up CleanSave

Complete the local installation and MCP connection requested by the user. The
canonical repository is <https://github.com/yuanbai/cleansave>. This skill can be
read directly from GitHub; installing a skill package is unnecessary.

## 1. Choose the installation and client

- Run on the user's computer with local terminal access. A remote sandbox cannot
  install a service on a different computer; explain that limitation if applicable.
- Identify the requesting agent and its active user/profile configuration. Configure
  that client only; ask which client if it cannot be determined. This setup request
  authorizes a user-scoped MCP entry, not system-wide settings or other clients.
- Reuse a known CleanSave installation and library. Otherwise use a per-user app
  directory, such as `~/.local/share/cleansave-app` on macOS/Linux or
  `%LOCALAPPDATA%\CleanSaveApp` on Windows. Keep the source checkout separate from
  the library. The CLI's default data directory is appropriate for a new library;
  a custom existing library must be passed explicitly to every service/MCP command.
- Read the checkout's `AGENTS.md` and this skill after cloning. Relative references
  below are files in this skill's `references/` directory, not shell commands or
  URLs relative to the user's current project.

## 2. Clone and build

1. Check Git, Node.js **24**, and the `packageManager` version in `package.json`
   (currently **pnpm 11.25.0**). Use the pinned version and committed lockfile.
2. If needed, provision prerequisites through an existing user-level version
   manager or an official distribution. Do not replace global Node defaults,
   run `sudo`, or pipe a remote script into a shell as part of this setup.
   If no suitable manager is available, give the concrete missing prerequisite
   and continue independent setup work. A private pnpm installation is sufficient:
   `npm install --prefix "/absolute/per-user/cleansave-tools" pnpm@11.25.0`;
   invoke its `node_modules/pnpm/bin/pnpm.cjs` with the selected Node executable.
3. Clone over public HTTPS:

   ```sh
   git clone https://github.com/yuanbai/cleansave.git "/absolute/per-user/cleansave-app"
   ```

   For an existing destination, check the remote and working tree. Reuse a matching
   checkout, including local edits; do not reset, clean, stash, or silently update
   it. If it is a different project, choose a free directory. Updates require the
   user's update request and a stopped backend before rebuilding its installation.

4. If an existing production build is present, check `service status` with its
   Node/CLI paths and the intended library first. Reuse a running installation
   without reinstalling or rebuilding it. A requested update must stop the
   backend before replacing its code. Otherwise, from the checkout, with Node 24
   and the pinned pnpm on PATH, run:

   ```sh
   pnpm install --frozen-lockfile
   pnpm build
   node -p "process.execPath"
   node -p "process.cwd() + '/dist/cli.js'"
   ```

   Record the absolute Node and CLI paths, and the checked-out commit. Resolve
   actual paths; never put `~`, relative paths, shell substitutions, or pnpm commands
   into a GUI client's MCP command. Paths containing spaces must remain single arguments.
   A Node binary managed by a version manager must remain installed after setup.

## 3. Start the background service

Use the absolute paths above; do not start a shell job with `&` or `nohup`:

```sh
"/absolute/path/to/node" "/absolute/path/to/cleansave/dist/cli.js" service start
"/absolute/path/to/node" "/absolute/path/to/cleansave/dist/cli.js" service status --verify-mcp
```

For a custom library or port, use `--data-dir "/absolute/library" --port 4888`
on start and the same `--data-dir` on status/stop. Service commands return JSON
with the actual URL, data directory, private log location, and a token-free `mcp`
command descriptor. Use that descriptor for registration. `mcpVerified: true`
means the stdio adapter really called `get_capabilities` and `list_records`.
It does not prove that this agent session has loaded the tools.

- Repeating start reuses an owned running backend. A foreground backend or a port
  occupant is not adopted or stopped. Inspect the conflict and choose a free port
  or reuse the user's existing service; never silently switch to an empty library.
- The backend binds only to loopback. Pairing is disabled by default. Preserve any
  existing access policy, proxy, or browser options; do not import browser cookies.
- Logs and control state live privately in the library directory. Do not paste
  their contents, tokens, raw share messages, or saved records into setup output.
- Keep the backend alive after the agent turn. **Do not install launchd, systemd,
  login items, scheduled tasks, or any login/reboot autostart.** After reboot the
  user can run `service start` again. MCP itself never starts a backend.

## 4. Register MCP at user scope

Read the reference for the current client only:

- [Codex](references/codex.md)
- [Claude Code](references/claude-code.md)
- [Hermes](references/hermes.md)
- [OpenClaw](references/openclaw.md)

Inspect the installed client's help before using its registration command.
Preserve other server entries and user settings. If `cleansave` already matches
the descriptor, leave it in place. Repair a different entry only if it clearly
belongs to this installation; otherwise use a free descriptive name and report it.
Do not copy credentials: `mcp` reads `credentials/agent-token.txt` from the matching
library. Do not change the client's model, login, tool permissions, or transport defaults.

For another stdio-capable local agent, use its documented user-level registration
mechanism and the same descriptor. Do not guess a configuration path or replace
an entire config file. If registration is blocked by a running client or unsupported
version, leave the verified backend running and report the exact remaining step.

## 5. Verify and hand over

- Confirm the backend's actual `/health` returns `{"status":"ok"}` and run
  `service status --verify-mcp`. An empty library is a valid result.
- Check native MCP registration and, if the current agent can reload safely, call
  `get_capabilities` and `list_records` through its own tool connection. Otherwise
  state that the standalone MCP check passed and explain the necessary reload.
- Report the clickable local URL, installation and data directories, configured
  client/scope/server name, and exact start/status/stop commands with absolute paths.
  State that no reboot autostart was installed. Describe unresolved prerequisites
  or registration steps candidly; never claim completion based on config alone.

Setup does not need a social-media link, a media download, telemetry, or a paid
account. For later use, the adjacent `cleansave-save-media` and
`cleansave-browse-library` skills describe the library tools.
