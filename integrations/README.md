# Agent integrations

Follow the [MCP quick-start guide](../docs/quick-start.md#connect-an-agent-with-mcp)
for step-by-step Codex, Claude Code, and generic stdio client setup.

Start the CleanSave backend first. The stdio adapter connects to the running
backend and reads `credentials/agent-token.txt` from the same data directory.
It never starts another backend or opens SQLite. The default token grants
read/write access; deletion and local paths require additional scopes.

## Included assets

| Path                                                                   | Purpose                                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [`codex/config.example.toml`](codex/config.example.toml)               | Codex stdio configuration template.                                                                                |
| [`generic/mcp.json`](generic/mcp.json)                                 | Generic MCP client configuration template.                                                                         |
| [`skills/cleansave-save-media/`](skills/cleansave-save-media/)         | Guidance for saving, downloading, and refreshing records.                                                          |
| [`skills/cleansave-browse-library/`](skills/cleansave-browse-library/) | Guidance for browsing records, retained media, and count history.                                                  |
| `plugin/`                                                              | Optional compatibility manifests and MCP configuration; `pnpm build` copies the canonical skills into this bundle. |

Replace example paths with absolute paths. For a custom port, pass
`--base-url http://127.0.0.1:PORT`. `CLEANSAVE_URL` and `CLEANSAVE_TOKEN` are
process-environment overrides; keep token secrets out of committed configuration.

MCP works independently of the optional skills. The compatibility plugin expects
`cleansave` on PATH and uses the default library unless environment overrides are
provided. Its harness-specific loading is experimental; the documented stdio
setup is the supported connection path. Do not configure both paths under the
same server name.
