# wp-journeys

An end-to-end journey runner for WordPress plugins, and it works with any plugin. Point it at a
local site and a plugin slug. It finds the admin screens, shortcodes and blocks the plugin adds,
drives them as six actors (`anonymous`, `subscriber`, `contributor`, `author`, `editor` and
`administrator`), uninstalls the plugin, and checks what the uninstall left behind. Throughout,
it watches the page's HTTP status, console errors, uncaught JavaScript errors, failed requests,
PHP diagnostics printed into the page, and `debug.log`. **The binding constraint: a lost or skipped signal is never reported
as ok.** A skip is its own outcome and is always shown. A signal the runner could not read
counts as a failure, not a clean pass.

Built with Playwright and TypeScript. Node 22.18+ runs the TypeScript directly; there is no build
step.

## Requirements

| Need | Notes |
|---|---|
| Node 22.18+ | Runs the `.ts` sources natively; type stripping is unflagged from 22.18. |
| pnpm | The lockfile is pnpm's (`pnpm install --frozen-lockfile`). |
| A local WordPress | Only `localhost`, `127.0.0.1`, `[::1]`, `*.test` and `*.localhost` are accepted. [wp-harness](https://github.com/carmelosantana/wp-harness) is optional. |
| wp-cli for that site | Used only to activate, deactivate and uninstall the plugin under test. |

## Quick start

```bash
git clone https://github.com/carmelosantana/wp-journeys.git && cd wp-journeys
pnpm install
pnpm browser                      # fetches Chromium; nothing is downloaded at install time
# install the companion mu-plugin on the site (below), then:
export WPJ_BASE_URL=https://mysite.test
export WPJ_AGENT_SECRET=...       # the same value as the site's WPJ_AGENT_SECRET
export WPJ_WP="wp --path=/srv/mysite"
node bin/wpj.js run --plugin <slug>
```

**A completed run uninstalls the plugin under test.** Its options, tables, cron events and user
meta are deleted, and only the plugin's files are kept (`--skip-delete`). The run also creates
the `wpj_*` users. Use a scratch site.

**The orphan check is sound only on a site where the plugin has never been activated.** Start
with the plugin inactive. If it is active when the run starts, the lifecycle row is a skip.
`wph mount` activates what it mounts, so deactivate the plugin and clear its state first.

## The companion mu-plugin

> **DEV-ONLY. Never install it on a production site.**
> It can **mint a login** for the runner's own `wpj_*` users. It exposes the site's surface and
> its `debug.log`. It renders any registered shortcode (`?wpj_render=[tag]`) or block
> (`?wpj_render_block=name`) on the front end. Its REST and discovery requests need the shared
> secret, and logins need a single-use token that only the secret can mint. **The render doors
> have no credential:** while the agent is enabled, anyone who can reach the site can call them.
> They accept only a bare tag or a block name.

It **fails closed.** It serves nothing unless all four of these hold: `WPJ_AGENT` is `true`,
the environment type is `local` or `development`, `WP_DEBUG` is on, and `WPJ_AGENT_SECRET` is
16 characters or more.

| Put | At |
|---|---|
| `mu-plugin/` | `wp-content/mu-plugins/wp-journeys-agent/` |
| `mu-plugin/loader.php` | `wp-content/mu-plugins/wp-journeys-agent.php` |

```php
define('WPJ_AGENT', true);
define('WP_ENVIRONMENT_TYPE', 'local');
define('WP_DEBUG', true);
define('WP_DEBUG_LOG', true);          // without it, the log signal is reported as lost
define('WPJ_AGENT_SECRET', '...');     // 16+ characters
```

On wp-harness, `scripts/scratch-site.sh` does all of this for the `wpjtest` site.

## Commands

| Command | Does |
|---|---|
| `node bin/wpj.js run --plugin <slug>` | Runs the conformance suite and prints the summary. Exit 0 means every row is ok or skip. Exit 1 means a failure, zero journeys, or a fatal error. Exit 2 means bad arguments, or `WPJ_WP` is unset. |
| `node bin/wpj.js mcp` | Serves the runner as MCP tools over stdio. |
| `node bin/wpj.js skills install` | Links the two agent skills into `~/.claude/skills`. |

## Environment

| Variable | Meaning |
|---|---|
| `WPJ_BASE_URL` | The target site. Local hostnames only. |
| `WPJ_AGENT_SECRET` | The shared secret the companion mu-plugin expects. |
| `WPJ_WP` | The wp-cli command used to toggle the plugin under test. |
| `HOME` | `skills install` links into `$HOME/.claude/skills`. |
| `WPJ_MANIFEST_DIR` | Optional. The directory holding the plugin's `wp-journeys.json`, which need not be the plugin root. |

## MCP

`wpj mcp` offers seven tools: `status`, `discover_surface`, `login_as`, `navigate`,
`read_page`, `drain_sentinel` and `run_journey`. `run_journey` deactivates and then reactivates
the plugin to take its baseline, and it refuses the `lifecycle` journey; run that with
`wpj run --plugin`. Any result that carries findings sets `isError`.

## Agent skills

`wpj skills install` symlinks `skills/wp-journeys-running` and `skills/wp-journeys-authoring`
into `~/.claude/skills`, so the clone stays the single source of truth. It replaces **only its
own symlinks**. If a directory or file is already at either path, it refuses, names the path,
deletes nothing and exits 1.

## For plugin authors

| Want | Read |
|---|---|
| Your own journeys: settings round-trips, expected denials, gates, declared deprecations | `wp-journeys.json`. Start from `assets/wp-journeys.example.json`, and use the **wp-journeys-authoring** skill. |
| Why a green row might have proved nothing | `skills/wp-journeys-authoring/references/false-greens.md` |
| A worked example against a real plugin | [docs/first-contact.md](docs/first-contact.md) |

## Distribution

wp-journeys runs from a clone. It is not published to npm (`"private": true`).
[docs/dependency-vet.md](docs/dependency-vet.md) lists what an npm release would need.

## License

[MIT](LICENSE)
