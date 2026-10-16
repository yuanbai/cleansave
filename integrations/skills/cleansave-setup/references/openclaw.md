# OpenClaw user registration

Use OpenClaw's native `mcp.servers` registry for the active local user/profile.
It is distinct from mcporter's configuration; installing mcporter is unnecessary
for versions with native MCP support.

1. Inspect `openclaw mcp --help`, `openclaw mcp add --help`, and existing registry
   entries. Check whether the local Gateway is running before mutating or probing.
2. **A running Gateway matters:** the CLI's registry mutation/probe path requires
   exclusive local state ownership and can refuse while the Gateway is running.
   If this agent is hosted by that Gateway, do not stop it and sever the user's
   conversation. Use the installed version's supported live configuration API or
   Control UI when available to add only the CleanSave entry. If it cannot be
   changed live, leave the backend running and explain the concrete remaining
   registration command for a time when the Gateway is stopped. Report MCP
   registration as pending in that case.
3. When the CLI can safely own state, substitute the exact service descriptor:

   ```sh
   openclaw mcp add cleansave --command "/absolute/path/to/node" --arg="/absolute/path/to/cleansave/dist/cli.js" --arg=mcp --arg=--base-url --arg=http://127.0.0.1:4777 --arg=--data-dir --arg="/absolute/library"
   ```

   Repeated `--arg` values preserve argument boundaries; the equals form prevents
   values such as `--base-url` being parsed as OpenClaw options. Check installed
   help before applying this syntax. Registration normally probes before saving.

4. Verify the selected entry with `openclaw mcp show cleansave` and the installed
   probe/doctor command when allowed. Preserve other servers and runtime/tool
   profiles. A minimal tool profile may hide MCP tools; explain that limitation
   instead of silently expanding the user's tool permissions.
5. `openclaw mcp reload` refreshes the calling process's cache; a separate live
   Gateway needs its own supported reload path. A saved entry or standalone
   CleanSave MCP check does not establish tool availability in that Gateway.

[Official native MCP registry documentation](https://docs.openclaw.ai/cli/mcp/registry).
