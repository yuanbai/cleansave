# Hermes user registration

Use Hermes's native MCP CLI for the active user/profile. Its MCP configuration
lives under `mcp_servers` in `~/.hermes/config.yaml`, with `HERMES_HOME`/profile
selection respected. Do not overwrite the YAML file or install a second Hermes.

1. Inspect `hermes mcp add --help` and `hermes mcp list`. Keep a matching entry.
2. On versions with native stdio registration, use:

   ```sh
   hermes mcp add cleansave --command "/absolute/path/to/node" --args "/absolute/path/to/cleansave/dist/cli.js" mcp --base-url http://127.0.0.1:4777 --data-dir "/absolute/library"
   ```

   `--args` consumes the remaining arguments; put it last. All values must come
   from the service's descriptor. If the installed parser requires an explicit
   argument separator, follow its help rather than changing the MCP command.

3. Use `hermes mcp test cleansave` to verify the configured connection, and
   `/reload-mcp` when supported by the running agent. Otherwise explain the need
   for a new session. Preserve unrelated servers and profile settings.
4. If the installed version lacks native MCP, report the needed supported version
   or documented user-level configuration step. Do not guess an alternative plugin.

[Official CLI reference](https://hermes-agent.nousresearch.com/docs/reference/cli-commands/)
and [MCP configuration](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference/).
