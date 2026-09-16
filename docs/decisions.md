# Decisions

Comments, tests and docs in this repository cite decisions by id (`R45`, `R95c`). This page
says what each one decided, in one sentence. The ids come from the working log kept while
wp-journeys was built; only the ids that appear in the repository are listed. A letter suffix
is part of a larger decision with the same number.

| Id | Decision |
|---|---|
| R1 | The response listener judges subresources only: a 5xx is a finding, anything else is not, and whether a denial was expected is decided for the main document alone. |
| R2 | Playwright's test directory is `tests/e2e`, so `playwright test` never runs the vitest suite. |
| R3 | A journey body that throws becomes an `assertion` finding on that journey, and the sentinel is still drained. |
| R3b | The CLI also guards each `journey.run()`, so a throw outside the lifecycle helper fails one row instead of the whole run. |
| R5 | The render door wraps its output in a marker, and a render counts only when the marker is present, because a refused door serves the home page with a 200. |
| R6 | Every `wp plugin uninstall` carries `--skip-delete`, because wp-harness mounts plugins read-write and a plain uninstall deletes the checkout. |
| R7a | The orphan check is complete only on a site where the plugin was never activated, and that limit is documented where the check lives. |
| R8 | Escape-hatch module paths are resolved to file URLs against the manifest directory, not against the importing module. |
| R10 | The plugin slug is validated against wp-harness's own slug rule before it can reach a shell. |
| R20 | The login proof checks which user a minted session belongs to, not merely that the mint redirected. |
| R22 | The canary is a committed mu-plugin armed and disarmed by an option, never by removing the mounted file. |
| R23 | The admin sweep is proven live for all six actors, together with one deliberately wrong expectation that must fail. |
| R28 | A top-level menu with no callback is linked at its first submenu's URL, as WordPress links it. |
| R31 | After any activate and deactivate cycle of the fixture plugin, its leftover state is removed before the next check. |
| R33 | The log offset is read with a size-only request (`logDelta('end')`), never by reading the whole file from zero. |
| R34 | wpdb's `WordPress database error … for query …` lines count as log diagnostics. |
| R36 | The agent only adopts and mints logins for users it created and marked itself, never for a user that merely has the right name. |
| R39 | A result with `skipReason` but without `skipped: true` is refused, because it would otherwise render as a pass. |
| R40 | A declared expectation applies to the next navigation only, then reverts to strict. |
| R41 | The body is scanned after every visit as well as at drain time, so every screen of a journey is covered. |
| R42 | When a navigation and the response listener report the same failure, the navigation's wording is kept. |
| R43 | A retried navigation discards what the abandoned attempt observed. |
| R44 | The lifecycle helper creates its own sentinel, so one sentinel can never be shared by two journeys. |
| R45 | A diagnostic the site writes on every request, with the plugin under test deactivated, is baseline noise and is subtracted from each journey. |
| R46 | Pending listener work is settled before the retry mark is taken, so an earlier screen's finding is never discarded by a retry. |
| R47 | The baseline's deactivate runs inside its guard, so the plugin is reactivated even when the deactivate call fails. |
| R48 | Baseline noise is sampled twice and only what both samples saw is kept. |
| R49 | The baseline also measures a front-end render, because a REST request never runs the theme. |
| R50 | A journey whose login failed does not run its body. |
| R51 | A minted login token is redacted from every finding, wherever the finding is built. |
| R52 | A login is judged by its navigation's verdict, not by where the page came to rest. |
| R53 | A proof that is meant to go red must assert that it did, and fail loudly when it did not. |
| R54 | A login needs positive evidence: a refused token is a loud failure, and a served control screen proves the session before any denial is believed. |
| R55 | The render door accepts exactly one bare shortcode tag and nothing else. |
| R56 | A container menu promoted to its first submenu's URL takes that submenu's capability, and duplicate URLs are swept once. |
| R57 | Blocks are rendered through their own door, alongside shortcodes. |
| R58 | Coverage counts only the journeys that ran; skips are shown but never counted. |
| R59 | A plan to move Playwright into runtime dependencies for an npm release; it was withdrawn by R100. |
| R60 | Diagnostics printed into the response body are baseline noise too, measured through the body and never through the log. |
| R62 | The canary proof arms the canary only after the baseline is captured, so its diagnostic is never measured as noise. |
| R63 | A body finding carries the diagnostic's message, file and line, so two different diagnostics never share a key. |
| R64 | The body scan reports every diagnostic in a render, not only the first. |
| R65 | A failed request that could not be classified is redacted like every other finding. |
| R66 | A settings read-back must see the written value appear, with a fresh suffix per run, not merely find it present. |
| R67 | Every step-based journey for a logged-in actor starts with a control visit that must be served. |
| R68a | Read-back text is compared case-insensitively with whitespace collapsed, because rendered text can change both. |
| R68b | A read-back page with no HTML body fails quickly and says so. |
| R68d | A throw from inside an escape-hatch module is wrapped with the journey and module names. |
| R70 | The manifest directory is set separately from the mounted plugin path, and the old variable name is refused. |
| R74 | A manifest may declare a shortcode deprecated, and only core's deprecation notice naming that tag is discounted, visibly. |
| R75 | If the plugin was active when the baseline was taken, the lifecycle row is a skip, never a pass. |
| R76 | A manifest gate must be served to the administrator, or every authored journey fails. |
| R77 | Discovered shortcodes and blocks render as the administrator and as an anonymous visitor. |
| R78 | A row whose every block is static is a skip, because only registration was checked. |
| R79 | A scheduled hook is excluded from orphans only when every callback on it is defined in core. |
| R80 | Each declared-deprecated shortcode renders on its own row, so a discount can never reach another tag's findings. |
| R84 | One primitive opens an actor's watched, authenticated session, and both journeys and the MCP server use it. |
| R85 | The MCP server holds one session at a time and reports a session's findings before closing it. |
| R86 | MCP `navigate` accepts only a path on the target site, with an optional expected denial for that one visit. |
| R87 | Every MCP tool result is redacted of login tokens. |
| R88 | MCP `run_journey` builds the run exactly as `wpj run` does, and refuses the lifecycle journey. |
| R89 | The MCP server starts even when configuration is broken, and never writes the shared secret. |
| R90 | While the MCP server runs, stdout carries protocol frames and nothing else. |
| R91 | The MCP protocol layer is hand-written, with no dependency. |
| R92 | MCP `status` says whether the log signal is available. |
| R93 | A supply-chain vetting pass for a dependency move that R100 later withdrew. |
| R95a | Every test that spawns a process has an explicit timeout. |
| R95b | A page that cannot be opened is covered by tests at the session level. |
| R95c | Login tokens are recognised in every encoding, by one shared pattern. |
| R95d | An MCP result that carries findings is always an error result. |
| R95e | The entry point's fatal error line is redacted of tokens and the secret. |
| R95f | A browser that disconnected is still closed, as far as possible, on shutdown. |
| R98 | `wpj skills install` replaces only its own links and refuses to touch anything else. |
| R99 | `wpj skills` is routed through the command line `main()` was given. |
| R100 | npm distribution is not offered in v1, so Playwright stays a development dependency and the package is private. |
| R101 | The wp-cli command has one name, `WPJ_WP`, and a live proof fails rather than skips when it is missing. |
| R102 | The public repository ships a README and an MIT licence. |
| R103 | The Node floor is 22.18, and the docs are checked against the code for variable names and manifest keys. |
