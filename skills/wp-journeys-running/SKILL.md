---
name: wp-journeys-running
description: Use when running the wp-journeys conformance suite (`wpj run`, `wpj mcp`) against a WordPress plugin, when reading or explaining a wp-journeys run summary (ok, FAIL(n), skip, coverage, discovered), when chasing a `phplog`, `bodyscan`, `response`, `console` or `assertion` finding, when a row reads `skip` and someone wants to call it a pass, when a lifecycle row reports orphaned options, when installing the companion mu-plugin (WPJ_AGENT, WPJ_AGENT_SECRET), or when pointing the runner at a wp-harness site or any other local WordPress.
---

# Running wp-journeys

## Overview

`wpj` drives a local WordPress as six actors, watches four live signals plus `debug.log`, and prints one row per journey. **A skip or a lost signal is never an ok.** A `skip` row asserted nothing. A lost signal is always a finding, so its row is red.

## Quick reference

| Task | Command |
|---|---|
| Run the suite | `wpj run --plugin <slug>` (in a checkout: `node bin/wpj.js run --plugin <slug>`) |
| Serve the MCP tools over stdio | `wpj mcp` (no arguments) |
| Link these skills into `~/.claude/skills` | `wpj skills install` |
| Fetch the browser, once | `npx playwright install chromium` |

| Variable | Meaning |
|---|---|
| `WPJ_BASE_URL` | The target site. Only `localhost`, `127.0.0.1`, `[::1]`, `*.test` and `*.localhost` are accepted. |
| `WPJ_AGENT_SECRET` | The shared secret (16+ characters). The mu-plugin must have the same value. Never print it. |
| `WPJ_WP` | The wp-cli command prefix, e.g. `node …/wp-harness/bin/wph.js wp <site> --` |
| `WPJ_MANIFEST_DIR` | Optional. The directory holding `wp-journeys.json`. This is **not** necessarily the plugin root you mounted. `WPJ_PLUGIN_DIR` is refused. |

**Exit codes.** `0`: every row is ok or skip. `1`: any FAIL, zero journeys, or a fatal error before the run. `2`: bad arguments, or `WPJ_WP` is unset.

## Before the first run

1. Install the companion mu-plugin, and make sure it refuses unless every gate is open. See [setup](references/setup.md).
2. **The site must be one where the plugin has never been activated**, and the plugin must be **inactive** at the start. If it was active, `lifecycle` is a visible skip. `wph mount` does not give you this on its own, because it *activates* what it mounts. Deactivate the plugin and delete its state first.
3. Point the runner at a scratch site. A completed run **uninstalls** the plugin under test (`--skip-delete` keeps the files) and creates the `wpj_*` users.

## Reading a summary

| Label | Meaning |
|---|---|
| `ok` | Ran, and nothing was observed. |
| `FAIL(n)` | `n` findings are listed under the row as `- [kind] text`. |
| `skip` | Its subject is absent, so it **asserted nothing**. The reason is printed. Never report this row as a pass. |
| `· note` | A condition the row's outcome rests on. It never changes the outcome. |

Two lines come before the rows. `coverage admin: X of Y` counts the journeys that ran (X) against the journeys aimed at that half of the site (Y); any gap between them is skips. `discovered:` lists what the run attributed to the plugin. What each finding kind means, and how to chase one down, is in [reading run output](references/run-output.md).

## MCP

`wpj mcp` has seven tools: `status`, `discover_surface`, `login_as`, `navigate`, `read_page`, `drain_sentinel`, `run_journey`. `run_journey` **deactivates and then reactivates** the plugin, so the plugin is left active. It refuses `lifecycle` journeys; run those with `wpj run`. See [mcp](references/mcp.md).

## Common mistakes

| Mistake | Fix |
|---|---|
| Reporting "N passed" when some of those rows were `skip` | Quote the header. Passed, failed and skipped are separate counts. |
| Running right after `wph mount` | Deactivate the plugin and delete its state first, or `lifecycle` misses the orphans. |
| Pointing `WPJ_MANIFEST_DIR` at the plugin root | Point it at the directory that holds `wp-journeys.json`. |
| Treating `debug.log signal unavailable` as noise | It means PHP diagnostics were **not read**. Turn on `WP_DEBUG_LOG`. |
| `Executable doesn't exist` | Run `npx playwright install chromium`. |

Writing a manifest, and the false greens to avoid, are covered by **wp-journeys-authoring**.
