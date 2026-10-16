# Codex user registration

Use the installed `codex mcp` CLI. It writes the personal configuration under
`$CODEX_HOME/config.toml` (normally `~/.codex/config.toml`); do not create a
project `.codex/config.toml` for this flow or change CODEX_HOME to another profile.

1. Inspect `codex mcp add --help` and `codex mcp get cleansave --json`. Treat a
   missing entry as a new setup. Keep an identical entry; preserve unrelated ones.
2. Substitute the exact command and arguments from service status:

   ```sh
   codex mcp add cleansave -- "/absolute/path/to/node" "/absolute/path/to/cleansave/dist/cli.js" mcp --base-url http://127.0.0.1:4777 --data-dir "/absolute/library"
   ```

   If a known old CleanSave entry must be repaired, `codex mcp remove cleansave`
   removes only that entry before adding its replacement. Keep a private backup
   until replacement succeeds; never echo an existing config that may hold secrets.

3. Check `codex mcp get cleansave --json` and `codex mcp list`. Do not add a token
   to `--env` or use OAuth for this local stdio adapter.
4. A new Codex session or an app/IDE reload may be required to load tools. `/mcp`
   in the CLI inspects active servers. Do not terminate the current conversation
   just to reload. Distinguish saved registration from tools active in this session.

[Official MCP guide](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
and [CLI reference](https://learn.chatgpt.com/docs/cli/reference).
