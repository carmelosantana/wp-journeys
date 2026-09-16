# wpj mcp

`wpj mcp` serves the runner as MCP tools over stdio. It takes no arguments, and stdout carries
only JSON-RPC. It starts even when configuration is broken; in that case, every tool that needs
the site answers with the configuration error. It reads the same variables as `wpj run`.

```json
{ "mcpServers": { "wp-journeys": { "command": "wpj", "args": ["mcp"],
  "env": { "WPJ_BASE_URL": "https://site.wp.test", "WPJ_AGENT_SECRET": "…", "WPJ_WP": "wp --path=/srv/site" } } } }
```

| Tool | Does | Watch out for |
|---|---|---|
| `status` | Reports the WordPress version, the PHP version, and whether the debug.log signal is available (and if not, why). | `UNAVAILABLE` means PHP diagnostics will **not** be read in any session. |
| `discover_surface` | Returns the screens, blocks, shortcodes, REST routes and capabilities the site registers **now**. | There is no baseline here, so every other plugin's surface is included. |
| `login_as {actor}` | Opens one isolated browser context as one of the six actors, with the sentinel armed. | Only one session is held. The previous one is drained first, and its findings are returned by this call. |
| `navigate {path, expect_denied?}` | Visits a site-relative path and returns the status, the final URL and a verdict for this visit. | `expect_denied` applies to this visit only. A denial expected for a logged-in actor proves nothing until the session is proved real: first navigate to `/wp-admin/profile.php` with `expect_denied: false`. |
| `read_page` | Returns the current page as readable text. | |
| `drain_sentinel` | Returns every finding so far, including the debug.log delta. | Findings are **not** baseline-subtracted, so noise the site emits on every request is reported too. |
| `run_journey {name, plugin}` | Runs one registered journey exactly as `wpj run` would, and returns its outcome. | It **deactivates and then reactivates** the plugin to take the baseline, so the plugin is left active, and that breaks the fresh-site precondition for a later `wpj run`. It refuses `lifecycle:<slug>`; run that with `wpj run`. |

`isError` is set on any result that carries findings, including one where the call itself
succeeded. When that happens, the text says so. Read the text; never read only the flag.

Tokens and the shared secret are redacted from every tool result.
