# Reading wpj run output

```
18 journeys: 15 passed, 1 failed, 2 skipped — coverage admin: 10 of 10, frontend: 7 of 9
  discovered: 2 admin screens, 2 shortcodes, 0 blocks, 13 REST routes
    screen    /wp-admin/admin.php?page=alpaca-bot (edit_posts)
    shortcode [alpacabot]
  ok       frontend-renders (anonymous/frontend) entitiesCreated=0
  ok       shortcode-render:alpaca-bot:anonymous:[alpacabot_agent] (anonymous/frontend) entitiesCreated=0
      · discounted 2 deprecation notices naming [alpacabot_agent], which the manifest declares deprecated (deprecated.shortcodes)
  skip     block-render:alpaca-bot:anonymous (anonymous/frontend) entitiesCreated=0 — skipped (alpaca-bot registered no blocks)
  FAIL(1)  lifecycle:alpaca-bot (administrator/admin) entitiesCreated=0
      - [assertion] alpaca-bot left state behind after uninstall: options=alpaca_bot_migrated_04, …; tables=none; cron=none; userMeta=none
```

## The header

- `passed`, `failed` and `skipped` are three separate counts, and they add up to the journey total.
- `coverage admin: X of Y` means Y journeys were aimed at wp-admin and X of them actually ran.
  A `both` journey counts toward each half. A FAIL counts as coverage, because the journey did
  drive that surface. A skip does not count. So a gap between X and Y is always skips.
- `discovered:` is everything the run attributed to the plugin: the screens, shortcodes and
  blocks it registered **beyond** a baseline taken with the plugin deactivated. REST routes are
  only counted.
- `0 journeys` exits 1 and says so. A suite that ran nothing asserted nothing.

## The rows, in the order they run

| Row | What it does | When it skips |
|---|---|---|
| `frontend-renders` | Loads `/` as an anonymous visitor. | never |
| `admin-sweep:<slug>:<actor>`, one per actor | Visits every discovered screen and asserts allow or deny from the site's real capability map. Every logged-in actor first visits `/wp-admin/profile.php` as a control: that page must be served, which proves the session is real. | The plugin added no admin screens. |
| `shortcode-render:<slug>:<actor>`, as administrator and as anonymous | Renders each discovered shortcode through the agent's render door. | The plugin registered no shortcodes. |
| `shortcode-render:<slug>:<actor>:[tag]` | One row for each tag the manifest declares deprecated. | never |
| `block-render:<slug>:<actor>` | Renders each dynamic block. | The plugin registered no blocks, or every block is static. |
| the manifest's own journeys | See wp-journeys-authoring. A failed `gate` fails every one of them. | Only if an escape-hatch module returns a skip. |
| `lifecycle:<slug>` | Uninstalls the plugin, then diffs options, tables, cron events and user meta against the baseline. | The plugin was **active** when the run started. |

## The six actors

`anonymous`, `subscriber`, `contributor`, `author`, `editor` and `administrator`. The runner
provisions each logged-in actor as `wpj_<role>`. Anonymous never logs in.

## Chasing a finding

| Kind | Source | What to do |
|---|---|---|
| `phplog` | A new line in `debug.log` during this journey, with the site's usual per-request noise subtracted. | The text is PHP's own message, file and line. Open that line. A message in `wp-includes/functions.php` comes from `_doing_it_wrong` or `_deprecated_*`, so the caller is the plugin. |
| `phplog` saying `debug.log signal unavailable (…)` | The log could not be read. | This is a **lost signal**, not a clean one. Fix `WP_DEBUG_LOG` or file permissions, then rerun. |
| `bodyscan` | A PHP diagnostic printed into the HTML (`WP_DEBUG_DISPLAY`). | Same as `phplog`. If `debug.log` is off, this is the only signal you have. |
| `response` | The page's main document was not what the journey needed. For example: `expected a permission denial … returned HTTP 200` (an access hole), `returned HTTP 403` where access was expected, `redirected to the login page`, or any 5xx. | A `redirected to the login page` finding on a logged-in actor means the session was not established. |
| `console` | `console.error` on the page. Echoes of 4xx subresources are dropped. | Check the browser console for the same URL. |
| `requestfailed` | A request that got no response at all. | `ERR_NETWORK_CHANGED` is filtered out, because the runner's own wp-cli calls cause it. |
| `assertion` | The journey's own check failed: orphans, a failed read-back, a failed gate, or a journey that threw. | Read the sentence. Each one names its likely causes. |

A `·` note line never changes the outcome. It states a condition the outcome rests on: a
precondition a pass depends on, a check the row could not make, or a finding the row
discounted because the manifest declared it.

## Rules for reporting a run to a human

- Quote the header verbatim, including the skip count.
- Name every skip and its reason. A skip is a journey that asserted nothing.
- A red `lifecycle` with orphans on a never-activated site is a defect in the plugin, not in
  the runner. List the orphans.
- Never shorten `FAIL` to "flaky" without evidence. The runner retries navigation once and never
  retries input.
