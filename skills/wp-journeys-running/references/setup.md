# Setting up a target site

## The companion mu-plugin

The runner reaches WordPress through a dev-only must-use plugin that **fails closed**. It serves
a request only when all four of these hold. Anything missing or ambiguous is a refusal:

| Gate | wp-config.php |
|---|---|
| Explicitly enabled | `define('WPJ_AGENT', true);` (the boolean `true`; the string `'1'` is refused) |
| A development site | `define('WP_ENVIRONMENT_TYPE', 'local');` (or `'development'`) |
| Debugging on | `define('WP_DEBUG', true);` |
| A shared secret | `define('WPJ_AGENT_SECRET', '<16+ chars>');`, the same value as the runner's `WPJ_AGENT_SECRET` |

Also set `define('WP_DEBUG_LOG', true);`. Without it the log signal is lost, and every row
that depended on it says so as a finding.

WordPress loads only top-level files in `mu-plugins/`, so the agent is two pieces:

| Piece | Goes to |
|---|---|
| the package's `mu-plugin/` directory | `wp-content/mu-plugins/wp-journeys-agent/` |
| `mu-plugin/loader.php` | `wp-content/mu-plugins/wp-journeys-agent.php` |

### On a wp-harness site

```bash
WPH="node /path/to/wp-harness/bin/wph.js"   # wph is often not on PATH
$WPH mount <site> mu wp-journeys-agent     "$PKG/mu-plugin"
$WPH mount <site> mu wp-journeys-agent.php "$PKG/mu-plugin/loader.php"
$WPH wp <site> -- config set WP_DEBUG true --raw
$WPH wp <site> -- config set WP_DEBUG_LOG true --raw
$WPH wp <site> -- config set WP_ENVIRONMENT_TYPE local
$WPH wp <site> -- config set WPJ_AGENT true --raw
$WPH wp <site> -- config set WPJ_AGENT_SECRET "$WPJ_AGENT_SECRET" > /dev/null   # keep it out of logs
export WPJ_BASE_URL=https://<site>.wp.test
export WPJ_WP="$WPH wp <site> --"
```

A mount of a single **file** is bound to that file's inode when the container is created. If
you replace `loader.php` (for example with an editor that writes a new file), the container
keeps running the old copy until the site is stopped and started again. Edits inside the
mounted **directory** take effect immediately.

### On any other local WordPress

Copy or symlink the two pieces into place, set the constants, and set `WPJ_WP` to a wp-cli
command that reaches the site, for example `wp --path=/srv/site` or
`docker compose exec -T cli wp`. The runner runs `$WPJ_WP plugin activate|deactivate <slug>`
and `$WPJ_WP plugin uninstall <slug> --deactivate --skip-delete` through `sh -c`, and uses
wp-cli for nothing else.

## Mounting the plugin under test

The mount path is the plugin root. The manifest directory is wherever the plugin keeps
`wp-journeys.json`, for example `tests/e2e`. These are two different paths.

```bash
$WPH mount <site> plugin <slug> /path/to/plugin
export WPJ_MANIFEST_DIR=/path/to/plugin/tests/e2e   # optional
```

## The fresh-site precondition

The orphan check compares the site after the uninstall with a baseline taken with the plugin
deactivated. Anything an **earlier** activation created is already in that baseline, so the
check cannot see it, and that is exactly the state an uninstall routine is supposed to remove.

1. Use a site where the plugin has never been activated. A new scratch site per plugin is the
   simplest way to get one.
2. Start the run with the plugin **inactive**. If it is active, the runner records that, and
   `lifecycle` comes out as a skip, not an ok. Any orphans it finds still fail the row.
3. `wph mount` activates the plugin it mounts, and the first request afterwards writes
   whatever the plugin writes. So after mounting, deactivate the plugin and delete its
   options, cron events and user meta. Or mount it on a site you will throw away after one run.

A plugin that was activated and then deactivated **before** the run still leaves its state
in the baseline, and the runner cannot tell. The skip covers only the active-at-start case.

## After a run

The lifecycle journey ran the plugin's uninstall routine, so the plugin is inactive. If the
row listed orphans, those rows are still on the site. Delete them before the next run, or
that run's baseline already contains them and the next lifecycle row reads clean.
