# Claude Code user registration

1. Inspect `claude mcp add --help` and `claude mcp get cleansave`. The explicit
   **user** scope is necessary: the CLI's default local scope is project-specific.
2. Use the service status descriptor as individual arguments:

   ```sh
   claude mcp add --transport stdio --scope user cleansave -- "/absolute/path/to/node" "/absolute/path/to/cleansave/dist/cli.js" mcp --base-url http://127.0.0.1:4777 --data-dir "/absolute/library"
   ```

   This uses the active user's Claude configuration, normally `~/.claude.json`.
   Honor an existing `CLAUDE_CONFIG_DIR`. Do not write `.mcp.json` or use project
   or local scope for this setup. An existing local/project entry can shadow a
   user entry; inspect and report that conflict without deleting unrelated entries.

3. Keep an identical entry. To repair a known outdated user entry, make a private
   backup and use `claude mcp remove --scope user cleansave` before adding it again.
   If adding fails, restore only the affected entry, preserving concurrent changes.
4. Verify with `claude mcp get cleansave` and `/mcp` in Claude Code. Use the client's
   reload mechanism if offered; otherwise start a new session. Do not claim that
   a command-line registration has already loaded tools into the current session.

The adapter reads its own private token file; do not add token values to configuration.

[Official Claude Code MCP guide](https://code.claude.com/docs/en/mcp).
