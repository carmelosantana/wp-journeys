# First contact: Alpaca Bot

The first run of wp-journeys against a real plugin: Alpaca Bot 0.5.0 (`develop`), mounted on the
scratch site `wpjtest` (WordPress 7.1, PHP 8.4). Tasks 1-13 built the runner against a synthetic
fixture. This page records what the contract got wrong when it met a real plugin, and what was
done about each finding.

Every output below is the runner's real stdout, copied verbatim. Nothing in any of these runs
carried the agent secret or a minted login token; each output file was checked for both before
it was quoted.

Each finding is one of three kinds:

| Classification | Meaning | What was done |
|---|---|---|
| **Alpaca Bot defect** | the plugin is wrong | reported here; the runner is not changed |
| **Runner false result** | the runner reported something untrue, either a false red or a lost signal | a failing unit test first, then the fix |
| **Contract gap** | the SDK could not express or see something a real plugin needs | the SDK was changed, or the gap is recorded as open |

## Summary of findings

| # | Finding | Classification | Resolution |
|---|---|---|---|
| 1 | The mount path and the manifest directory are two different paths | Contract gap (R70) | `WPJ_PLUGIN_DIR` renamed `WPJ_MANIFEST_DIR`; the old name, an empty directory and a manifest for another plugin are all refused; `interpret()` now requires the directory. Commit `1ee50bc` |
| 2 | `[alpacabot_agent]` reported as "came back verbatim" when it had expanded | Runner false red | The agent now reports expansion (`data-wpj-expanded`); the runner no longer guesses from the text. Commit `c710d86` |
| 3 | A PHP notice printed before any markup was invisible to the body scan | Runner lost signal (false green when `debug.log` is off) | The plain-text form now also matches directly after `<body>`. Commit `39a62f8` |
| 4 | The summary never named the discovered surface | Contract gap | The summary lists the screens, shortcodes and blocks the run attributed to the plugin. Commit `33b6d48` |
| 5 | The lifecycle journey reported `ok` while four options survived the uninstall | Runner false green, the known R7a limit made real by the workflow | Explained and recorded; no code fix. See the open questions |
| 6 | Alpaca Bot has no uninstall routine | **Alpaca Bot defect** | Reported below |
| 7 | `[alpacabot_agent]` emits a deliberate `_doing_it_wrong` deprecation notice whenever it renders | Contract gap | **Open.** The red is left standing. See the open questions |
| 8 | The plugin's only setting that appears on the frontend is a `<textarea>`, and Enter does not submit one | Contract gap (proven live, run 3) | Optional `submit` selector on a settings entry, clicked once. Commit `7bac8b4` |
| 9 | A failed read-back did not name "the readBack page does not show this setting" as a cause | Runner message error (Step 6) | Commit `642c1e7` |
| 10 | Blocks were discovered and never rendered | Contract gap (R57) | New `block-render` journey behind a guarded block door. It skips visibly for Alpaca Bot, which registers no blocks. Commit `5644848` |
| 11 | A core cron event scheduled lazily between the baseline and the uninstall is blamed on the plugin | Runner false red (carried from Task 11, seen live in Task 12) | The agent reports which scheduled hooks loaded code still handles; after the uninstall those are not the plugin's. Commit `cac2f9b` |
| 12 | The render door refused shortcode tags that core accepts | Runner false red, latent | Widened to core's own forbidden class. Alpaca Bot's tags did not need it. Commit `4bd60b9` |
| 13 | A read-back failure was always called "no HTML body" | Runner message error (Task 13, parked) | Only a Playwright `TimeoutError` gets that diagnosis. Commit `7466414` |
| 14 | `manifest.gate` is parsed and never consulted | Contract gap | **Open.** Recorded; not changed |
| 15 | `accessMatrix` judges role capabilities, not effective ones | Known, expected | Not triggered: both Alpaca Bot screens are gated by plain role capabilities (`edit_posts`, `manage_options`) |
| 16 | Conflicting expectations for one URL (R56) | Known | Not triggered: Alpaca Bot's top-level menu mirrors itself, so it is not promoted |

## 1. The mount path is not the manifest directory (R70)

This was a contract gap, found before the first run. The brief treated "the plugin directory" as
one path. On Alpaca Bot it is two:

- **The mount path** is the plugin root, `<plugin checkout>`.
  wp-harness mounts this path. (`<brand-assets folder>` itself is a folder of brand assets, not a
  plugin.)
- **The manifest directory** is `.../alpaca-bot/tests/e2e`. `loadManifest` reads
  `wp-journeys.json` from here, and `interpret()` resolves escape-hatch module paths against it
  and confines them inside it.

The variable was named for the first path and used as the second. It is now `WPJ_MANIFEST_DIR`,
and the usage text says exactly what it points at. Mistakes are loud:

- Setting the old `WPJ_PLUGIN_DIR` is refused.
- A named directory with no `wp-journeys.json` in it is refused. The likeliest mistake is naming
  the plugin root, and it used to read as "this plugin has no manifest".
- A manifest whose `plugin` field is not the `--plugin` slug is refused.

`interpret()`'s directory argument has no default any more. Its old `'.'` default silently
resolved module paths against the runner's working directory. The compiler caught the four call
sites that omitted it.

The manifest is loaded before the baseline, so a manifest that cannot run costs no deactivate and
no suite. Authored journeys run after the discovered-surface journeys and before `lifecycle`,
because `lifecycle` uninstalls the plugin every other journey needs.

The working invocation:

```bash
WPH="node $WPH_CHECKOUT/bin/wph.js"
$WPH mount wpjtest plugin alpaca-bot "$HOME/Projects/Alpaca Bot/wp-alpaca/plugins/alpaca-bot"
set -a; . ./.env; set +a                       # WPJ_BASE_URL, WPJ_AGENT_SECRET
export WPJ_WP="$WPH wp wpjtest --"
export WPJ_MANIFEST_DIR="$HOME/Projects/Alpaca Bot/wp-alpaca/plugins/alpaca-bot/tests/e2e"
node bin/wpj.js run --plugin alpaca-bot
```

## Run 1: no manifest, runner at `1ee50bc` (Step 2)

`wph mount` had just activated Alpaca Bot for the first time. Exit 1.

```
9 journeys: 8 passed, 1 failed, 0 skipped — coverage admin: 8 of 8, frontend: 2 of 2
  ok       frontend-renders (anonymous/frontend) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:anonymous (anonymous/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:subscriber (subscriber/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:contributor (contributor/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:author (author/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:editor (editor/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:administrator (administrator/admin) entitiesCreated=0
  FAIL(2)  shortcode-render:alpaca-bot (administrator/both) entitiesCreated=0
      - [phplog] PHP Notice: Function alpacabot_agent was called incorrectly. The [alpacabot_agent] shortcode is deprecated since 0.5.0 and goes away in a later 0.x release. It still fetches its URL and, for summarize, asks the model. Put the text to work on in the prompt of [alpacabot prompt="Summarize the following: …"] instead, or open the URL in the chat screen, where the web_fetch and summarize tools read it for you. Please see Debugging in WordPress for more information. (This message was added in version 0.5.0.) in /var/www/html/wp-includes/functions.php on line 6260
      - [assertion] the shortcode [alpacabot_agent] came back verbatim — WordPress returns an unregistered shortcode unchanged, so it never expanded
  ok       lifecycle:alpaca-bot (administrator/admin) entitiesCreated=0
```

Measured against the brief's expected output:

- The summary names no discovered admin screens (finding 4).
- There are two findings on one journey (findings 2, 3 and 7).
- There is no orphan report. `lifecycle` reads `ok` (findings 5 and 6).

### Finding 2: "came back verbatim" was untrue

Fetched through the render door:

```
<div data-wpj-render="1"><p class="alpaca-bot-notice">[alpacabot_agent] needs a url attribute.</p></div>
```

The shortcode expanded; its output quotes its own tag. `shortcodeRenderDefect` decided expansion
by whether the literal `[alpacabot_agent]` was absent from the page, so it reported a false
defect. Only the agent can tell an unchanged string from output that mentions the tag. The door
now emits `data-wpj-expanded="1"` or `"0"` (`do_shortcode()` returned its input unchanged, or
did not). A marker without the flag fails; the runner never falls back to the guess. After the
fix, live:

```
<div data-wpj-render="1" data-wpj-expanded="1"><p class="alpaca-bot-notice">[alpacabot_agent] needs a url attribute.</p></div>
<div data-wpj-render="1" data-wpj-expanded="0">[nope_not_real]</div>
```

### Finding 3: a notice at the top of the page was invisible to the body scan

The same response carried the notice in its body, because `WP_DEBUG_DISPLAY` is on. Run 1 only
reported it through `phplog`. A probe of the same URL showed why:

```
RAW first 60: "\nNotice: Function alpacabot_agent was called <strong>incorre"
DOM first 60: "<html><head></head><body>Notice: Function alpacabot_agent wa"
scanBody(raw): 1
scanBody(dom): 0
```

The sentinel scans `page.content()`, the browser's serialisation of the page. When PHP prints
before any markup, the HTML parser drops the leading newline and puts the text straight after an
implied `<body>`. A later `<body class=...>` lends that element its attributes. The plain-text
pattern was anchored with `^`, so it never matched there. On a site with `WP_DEBUG_LOG` off, the
body scan is the only signal, so this notice would have produced a clean pass. After the fix the
probe reads `scanBody(dom): 1`. Runs 2 onward report the notice under both `bodyscan` and
`phplog`.

### Findings 5 and 6: `lifecycle: ok` was a false green

After run 1, wpjtest still held four options that Alpaca Bot writes on its first `init`
(`Settings\Migrate04`):

```
alpaca_bot_migrated_04
alpaca_bot_migrated_retention
alpaca_bot_migrated_04_conversations
alpaca_bot_migrated_flag_autoload
```

`wph mount` activates the plugin it mounts, so those options already existed when the runner
took its baseline. They were in `before`, and the diff could not see them. This is the R7a limit
documented in `src/suite/lifecycle.ts`: orphan detection is complete only on a site where the
plugin has never been activated. The brief's workflow guarantees that it has been.

To see the real result, wpjtest was put back in a never-activated state for Alpaca Bot: the
plugin deactivated, its options deleted, no cron event, no user meta. Run 2 was then made on that
state.

## Run 2: never-activated baseline, runner at `33b6d48`

Exit 1.

```
9 journeys: 7 passed, 2 failed, 0 skipped — coverage admin: 8 of 8, frontend: 2 of 2
  ok       frontend-renders (anonymous/frontend) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:anonymous (anonymous/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:subscriber (subscriber/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:contributor (contributor/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:author (author/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:editor (editor/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:administrator (administrator/admin) entitiesCreated=0
  FAIL(2)  shortcode-render:alpaca-bot (administrator/both) entitiesCreated=0
      - [bodyscan] PHP Notice printed into the response body at https://wpjtest.wp.test/?wpj_render=%5Balpacabot_agent%5D: Function alpacabot_agent was called incorrectly. The [alpacabot_agent] shortcode is deprecated since 0.5.0 and goes away in a later 0.x release. It still fetches its URL and, for summarize, asks the model. Put the text to work on in the prompt of [alpacabot prompt="Summarize the following: …"] instead, or open the URL in the chat screen, where the web_fetch and summarize tools read it for you. Please see Debugging in WordPress for more information. (This message was added in version 0.5.0.) in /var/www/html/wp-includes/functions.php on line 6260
      - [phplog] PHP Notice: Function alpacabot_agent was called incorrectly. The [alpacabot_agent] shortcode is deprecated since 0.5.0 and goes away in a later 0.x release. It still fetches its URL and, for summarize, asks the model. Put the text to work on in the prompt of [alpacabot prompt="Summarize the following: …"] instead, or open the URL in the chat screen, where the web_fetch and summarize tools read it for you. Please see Debugging in WordPress for more information. (This message was added in version 0.5.0.) in /var/www/html/wp-includes/functions.php on line 6260
  FAIL(1)  lifecycle:alpaca-bot (administrator/admin) entitiesCreated=0
      - [assertion] alpaca-bot left state behind after uninstall: options=alpaca_bot_migrated_04, alpaca_bot_migrated_04_conversations, alpaca_bot_migrated_flag_autoload, alpaca_bot_migrated_retention; tables=none; cron=none; userMeta=none
```

The shortcode row no longer carries the false "verbatim" finding, and the notice now appears
under `bodyscan` as well. `lifecycle` reports the orphans.

### Finding 6 (Alpaca Bot defect): no uninstall routine

Alpaca Bot 0.5.0 has neither `uninstall.php` nor `register_uninstall_hook`. After
`wp plugin uninstall alpaca-bot --deactivate --skip-delete`, these survive:

- the four `alpaca_bot_migrated_*` flags;
- `alpaca_bot_settings`, once settings have been saved (runs 4 to 6).

The following are not in the snapshot's scope, and would survive too, by the code:

- conversation and usage-receipt posts (two custom post types);
- the `alpaca_bot_default_model` user meta (`Chat\UserPrefs`, written only when a user picks a model);
- the plugin's transients.

`Plugin::deactivate()`'s docblock says "Options, conversations and receipts stay; deactivation is
not uninstall", which implies that uninstall removes them. Nothing does. Reported here, not fixed:
this task does not change Alpaca Bot's source.

## Run 3: with the manifest, current contract (Step 4)

The manifest as first written: the settings entry had no `submit` key. Exit 1.

```
14 journeys: 10 passed, 3 failed, 1 skipped — coverage admin: 11 of 12, frontend: 4 of 5
  discovered: 2 admin screens, 2 shortcodes, 0 blocks, 13 REST routes
    screen    /wp-admin/admin.php?page=alpaca-bot (edit_posts)
    screen    /wp-admin/admin.php?page=alpaca-bot-settings (manage_options)
    shortcode [alpacabot]
    shortcode [alpacabot_agent]
  ok       frontend-renders (anonymous/frontend) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:anonymous (anonymous/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:subscriber (subscriber/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:contributor (contributor/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:author (author/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:editor (editor/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:administrator (administrator/admin) entitiesCreated=0
  FAIL(2)  shortcode-render:alpaca-bot (administrator/both) entitiesCreated=0
      - [bodyscan] PHP Notice printed into the response body at https://wpjtest.wp.test/?wpj_render=%5Balpacabot_agent%5D: Function alpacabot_agent was called incorrectly. The [alpacabot_agent] shortcode is deprecated since 0.5.0 and goes away in a later 0.x release. It still fetches its URL and, for summarize, asks the model. Put the text to work on in the prompt of [alpacabot prompt="Summarize the following: …"] instead, or open the URL in the chat screen, where the web_fetch and summarize tools read it for you. Please see Debugging in WordPress for more information. (This message was added in version 0.5.0.) in /var/www/html/wp-includes/functions.php on line 6260
      - [phplog] PHP Notice: Function alpacabot_agent was called incorrectly. The [alpacabot_agent] shortcode is deprecated since 0.5.0 and goes away in a later 0.x release. It still fetches its URL and, for summarize, asks the model. Put the text to work on in the prompt of [alpacabot prompt="Summarize the following: …"] instead, or open the URL in the chat screen, where the web_fetch and summarize tools read it for you. Please see Debugging in WordPress for more information. (This message was added in version 0.5.0.) in /var/www/html/wp-includes/functions.php on line 6260
  skip     block-render:alpaca-bot (administrator/both) entitiesCreated=0 — skipped (alpaca-bot registered no blocks)
  FAIL(1)  alpaca-bot-welcome-round-trip (administrator/both) entitiesCreated=0
      - [assertion] read-back failed for "alpaca-bot-welcome-round-trip": wrote "Welcome from wp-journeys wpj-8dffb524" to #ab-chat-welcome on /wp-admin/admin.php?page=alpaca-bot-settings&tab=chat, but it never appeared at /?wpj_render=%5Balpacabot%5D. Either the save was refused — a validation or capability failure answers with a redirect back to the form, not an error — or the submit never happened: Enter submits an <input> inside a <form>, not a <textarea> or a field without one.
  ok       alpaca-bot-editor-chats-but-cannot-configure (editor/admin) entitiesCreated=0
  ok       alpaca-bot-subscriber-cannot-chat (subscriber/admin) entitiesCreated=0
  ok       alpaca-bot-shortcode-for-a-visitor (anonymous/frontend) entitiesCreated=0
  FAIL(1)  lifecycle:alpaca-bot (administrator/admin) entitiesCreated=0
      - [assertion] alpaca-bot left state behind after uninstall: options=alpaca_bot_migrated_04, alpaca_bot_migrated_04_conversations, alpaca_bot_migrated_flag_autoload, alpaca_bot_migrated_retention; tables=none; cron=none; userMeta=none
```

### Finding 8: Enter cannot submit a `<textarea>`

The only Alpaca Bot setting that reaches visible frontend text is the welcome message
(`chat.welcome`), shown by the chat shell that `[alpacabot]` renders. A probe confirmed the field
is `TEXTAREA in form=true`, and that `#submit` is an `INPUT type=submit`. The interpreter pressed
Enter, which adds a newline to a textarea, so the form was never posted. The read-back failed
exactly as its message predicted, and no `alpaca_bot_settings` row was created.

A settings entry now takes an optional `"submit": "<selector>"`, clicked exactly once and never
retried. Without it, Enter remains the default. An empty `submit` is refused rather than read as
"use Enter".

The readBack URL is the render door itself, `/?wpj_render=%5Balpacabot%5D`. It is a frontend URL
that renders the shortcode, and the manifest has no way to create a page to put one in. For an
administrator it shows the shell, whose visible text includes the welcome message.

## Run 4: with `submit` (Step 5)

Exit 1. All four authored journeys pass, and the read-back assertion ran: its write left
`alpaca_bot_settings` behind, which the orphan list now shows.

```
14 journeys: 11 passed, 2 failed, 1 skipped — coverage admin: 11 of 12, frontend: 4 of 5
  discovered: 2 admin screens, 2 shortcodes, 0 blocks, 13 REST routes
    screen    /wp-admin/admin.php?page=alpaca-bot (edit_posts)
    screen    /wp-admin/admin.php?page=alpaca-bot-settings (manage_options)
    shortcode [alpacabot]
    shortcode [alpacabot_agent]
  ok       frontend-renders (anonymous/frontend) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:anonymous (anonymous/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:subscriber (subscriber/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:contributor (contributor/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:author (author/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:editor (editor/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:administrator (administrator/admin) entitiesCreated=0
  FAIL(2)  shortcode-render:alpaca-bot (administrator/both) entitiesCreated=0
      - [bodyscan] PHP Notice printed into the response body at https://wpjtest.wp.test/?wpj_render=%5Balpacabot_agent%5D: Function alpacabot_agent was called incorrectly. The [alpacabot_agent] shortcode is deprecated since 0.5.0 and goes away in a later 0.x release. It still fetches its URL and, for summarize, asks the model. Put the text to work on in the prompt of [alpacabot prompt="Summarize the following: …"] instead, or open the URL in the chat screen, where the web_fetch and summarize tools read it for you. Please see Debugging in WordPress for more information. (This message was added in version 0.5.0.) in /var/www/html/wp-includes/functions.php on line 6260
      - [phplog] PHP Notice: Function alpacabot_agent was called incorrectly. The [alpacabot_agent] shortcode is deprecated since 0.5.0 and goes away in a later 0.x release. It still fetches its URL and, for summarize, asks the model. Put the text to work on in the prompt of [alpacabot prompt="Summarize the following: …"] instead, or open the URL in the chat screen, where the web_fetch and summarize tools read it for you. Please see Debugging in WordPress for more information. (This message was added in version 0.5.0.) in /var/www/html/wp-includes/functions.php on line 6260
  skip     block-render:alpaca-bot (administrator/both) entitiesCreated=0 — skipped (alpaca-bot registered no blocks)
  ok       alpaca-bot-welcome-round-trip (administrator/both) entitiesCreated=0
  ok       alpaca-bot-editor-chats-but-cannot-configure (editor/admin) entitiesCreated=0
  ok       alpaca-bot-subscriber-cannot-chat (subscriber/admin) entitiesCreated=0
  ok       alpaca-bot-shortcode-for-a-visitor (anonymous/frontend) entitiesCreated=0
  FAIL(1)  lifecycle:alpaca-bot (administrator/admin) entitiesCreated=0
      - [assertion] alpaca-bot left state behind after uninstall: options=alpaca_bot_migrated_04, alpaca_bot_migrated_04_conversations, alpaca_bot_migrated_flag_autoload, alpaca_bot_migrated_retention, alpaca_bot_settings; tables=none; cron=none; userMeta=none
```

## Run 5: the read-back can fail (Step 6)

The manifest's `readBack` was temporarily set to `/`, a page that never shows the chat shell.
Exit 1.

```
14 journeys: 10 passed, 3 failed, 1 skipped — coverage admin: 11 of 12, frontend: 4 of 5
  discovered: 2 admin screens, 2 shortcodes, 0 blocks, 13 REST routes
    screen    /wp-admin/admin.php?page=alpaca-bot (edit_posts)
    screen    /wp-admin/admin.php?page=alpaca-bot-settings (manage_options)
    shortcode [alpacabot]
    shortcode [alpacabot_agent]
  ok       frontend-renders (anonymous/frontend) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:anonymous (anonymous/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:subscriber (subscriber/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:contributor (contributor/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:author (author/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:editor (editor/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:administrator (administrator/admin) entitiesCreated=0
  FAIL(2)  shortcode-render:alpaca-bot (administrator/both) entitiesCreated=0
      - [bodyscan] PHP Notice printed into the response body at https://wpjtest.wp.test/?wpj_render=%5Balpacabot_agent%5D: Function alpacabot_agent was called incorrectly. The [alpacabot_agent] shortcode is deprecated since 0.5.0 and goes away in a later 0.x release. It still fetches its URL and, for summarize, asks the model. Put the text to work on in the prompt of [alpacabot prompt="Summarize the following: …"] instead, or open the URL in the chat screen, where the web_fetch and summarize tools read it for you. Please see Debugging in WordPress for more information. (This message was added in version 0.5.0.) in /var/www/html/wp-includes/functions.php on line 6260
      - [phplog] PHP Notice: Function alpacabot_agent was called incorrectly. The [alpacabot_agent] shortcode is deprecated since 0.5.0 and goes away in a later 0.x release. It still fetches its URL and, for summarize, asks the model. Put the text to work on in the prompt of [alpacabot prompt="Summarize the following: …"] instead, or open the URL in the chat screen, where the web_fetch and summarize tools read it for you. Please see Debugging in WordPress for more information. (This message was added in version 0.5.0.) in /var/www/html/wp-includes/functions.php on line 6260
  skip     block-render:alpaca-bot (administrator/both) entitiesCreated=0 — skipped (alpaca-bot registered no blocks)
  FAIL(1)  alpaca-bot-welcome-round-trip (administrator/both) entitiesCreated=0
      - [assertion] read-back failed for "alpaca-bot-welcome-round-trip": wrote "Welcome from wp-journeys wpj-8a0afe1a" to #ab-chat-welcome on /wp-admin/admin.php?page=alpaca-bot-settings&tab=chat, but it never appeared at /. Either the save was refused — a validation or capability failure answers with a redirect back to the form, not an error — or the submit never happened: clicking #submit did not post the form.
  ok       alpaca-bot-editor-chats-but-cannot-configure (editor/admin) entitiesCreated=0
  ok       alpaca-bot-subscriber-cannot-chat (subscriber/admin) entitiesCreated=0
  ok       alpaca-bot-shortcode-for-a-visitor (anonymous/frontend) entitiesCreated=0
  FAIL(1)  lifecycle:alpaca-bot (administrator/admin) entitiesCreated=0
      - [assertion] alpaca-bot left state behind after uninstall: options=alpaca_bot_migrated_04, alpaca_bot_migrated_04_conversations, alpaca_bot_migrated_flag_autoload, alpaca_bot_migrated_retention, alpaca_bot_settings; tables=none; cron=none; userMeta=none
```

The round-trip failed with the read-back message. That message named only two causes, a refused
save and a missing submit, and neither was the case: the save landed, as `alpaca_bot_settings` in
the orphan list shows. It now also names the third cause, a readBack page that does not show the
setting (finding 9).

## Run 6: restored manifest (Step 6 confirmation)

The manifest was restored, then compared byte for byte with the saved copy before it was
committed. Exit 1. All four authored journeys pass. The two remaining reds are finding 6 (a
genuine defect) and finding 7 (the open question below).

```
14 journeys: 11 passed, 2 failed, 1 skipped — coverage admin: 11 of 12, frontend: 4 of 5
  discovered: 2 admin screens, 2 shortcodes, 0 blocks, 13 REST routes
    screen    /wp-admin/admin.php?page=alpaca-bot (edit_posts)
    screen    /wp-admin/admin.php?page=alpaca-bot-settings (manage_options)
    shortcode [alpacabot]
    shortcode [alpacabot_agent]
  ok       frontend-renders (anonymous/frontend) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:anonymous (anonymous/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:subscriber (subscriber/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:contributor (contributor/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:author (author/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:editor (editor/admin) entitiesCreated=0
  ok       admin-sweep:alpaca-bot:administrator (administrator/admin) entitiesCreated=0
  FAIL(2)  shortcode-render:alpaca-bot (administrator/both) entitiesCreated=0
      - [bodyscan] PHP Notice printed into the response body at https://wpjtest.wp.test/?wpj_render=%5Balpacabot_agent%5D: Function alpacabot_agent was called incorrectly. The [alpacabot_agent] shortcode is deprecated since 0.5.0 and goes away in a later 0.x release. It still fetches its URL and, for summarize, asks the model. Put the text to work on in the prompt of [alpacabot prompt="Summarize the following: …"] instead, or open the URL in the chat screen, where the web_fetch and summarize tools read it for you. Please see Debugging in WordPress for more information. (This message was added in version 0.5.0.) in /var/www/html/wp-includes/functions.php on line 6260
      - [phplog] PHP Notice: Function alpacabot_agent was called incorrectly. The [alpacabot_agent] shortcode is deprecated since 0.5.0 and goes away in a later 0.x release. It still fetches its URL and, for summarize, asks the model. Put the text to work on in the prompt of [alpacabot prompt="Summarize the following: …"] instead, or open the URL in the chat screen, where the web_fetch and summarize tools read it for you. Please see Debugging in WordPress for more information. (This message was added in version 0.5.0.) in /var/www/html/wp-includes/functions.php on line 6260
  skip     block-render:alpaca-bot (administrator/both) entitiesCreated=0 — skipped (alpaca-bot registered no blocks)
  ok       alpaca-bot-welcome-round-trip (administrator/both) entitiesCreated=0
  ok       alpaca-bot-editor-chats-but-cannot-configure (editor/admin) entitiesCreated=0
  ok       alpaca-bot-subscriber-cannot-chat (subscriber/admin) entitiesCreated=0
  ok       alpaca-bot-shortcode-for-a-visitor (anonymous/frontend) entitiesCreated=0
  FAIL(1)  lifecycle:alpaca-bot (administrator/admin) entitiesCreated=0
      - [assertion] alpaca-bot left state behind after uninstall: options=alpaca_bot_migrated_04, alpaca_bot_migrated_04_conversations, alpaca_bot_migrated_flag_autoload, alpaca_bot_migrated_retention, alpaca_bot_settings; tables=none; cron=none; userMeta=none
```

### The committed manifest

On the Alpaca Bot branch `wp-journeys/first-contact`, local only, at
`tests/e2e/wp-journeys.json`:

```json
{
  "description": "wp-journeys manifest for Alpaca Bot. Run with WPJ_MANIFEST_DIR pointing at this directory (tests/e2e), not at the plugin root. JSON, so the plugin's own Playwright run does not collect it.",
  "version": 1,
  "plugin": "alpaca-bot",
  "journeys": [
    {
      "name": "alpaca-bot-welcome-round-trip",
      "actor": "administrator",
      "surface": "both",
      "settings": [
        {
          "url": "/wp-admin/admin.php?page=alpaca-bot-settings&tab=chat",
          "field": "#ab-chat-welcome",
          "value": "Welcome from wp-journeys",
          "readBack": "/?wpj_render=%5Balpacabot%5D",
          "submit": "#submit"
        }
      ]
    },
    {
      "name": "alpaca-bot-editor-chats-but-cannot-configure",
      "actor": "editor",
      "surface": "admin",
      "screens": [
        { "url": "/wp-admin/admin.php?page=alpaca-bot", "allow": ["editor"], "deny": [] },
        { "url": "/wp-admin/admin.php?page=alpaca-bot-settings", "allow": [], "deny": ["editor"] }
      ]
    },
    {
      "name": "alpaca-bot-subscriber-cannot-chat",
      "actor": "subscriber",
      "surface": "admin",
      "screens": [
        { "url": "/wp-admin/admin.php?page=alpaca-bot", "allow": [], "deny": ["subscriber"] }
      ]
    },
    {
      "name": "alpaca-bot-shortcode-for-a-visitor",
      "actor": "anonymous",
      "surface": "frontend",
      "shortcodes": ["alpacabot"]
    }
  ]
}
```

## Carried decisions, settled here

- **R57, blocks.** A `block-render` journey was added, symmetric with `shortcode-render`, behind a
  new guarded door, `?wpj_render_block=<name>`. The gate is core's block-name shape. The door
  reports `data-wpj-registered`, because `render_block` answers an unknown block with an empty
  string rather than an error. It also reports `data-wpj-dynamic`. A static block passes on
  registration alone, because its markup lives in post content. The journey skips visibly when
  the plugin added no blocks, as for Alpaca Bot. Proven live on the fixture's dynamic block, with
  a red case for an unregistered name.
- **Lazy core cron.** Solved by re-checking the hook's origin. The snapshot now carries
  `cronHandled`: the scheduled hooks that some loaded code answers (`has_action`). After the
  uninstall the plugin under test is not loaded, so a new hook that is still answered belongs to
  core or to another active plugin. Verified live in the agent's REST context: all twelve of
  wpjtest's core cron hooks are answered, `wp_delete_temp_updater_backups` included. The fixture's
  known leak, `wpj_fixture_daily`, is still caught (conformance e2e). An agent that does not send
  `cronHandled` excludes nothing, so it fails loud.
- **The shortcode tag class.** Widened deliberately to core's rule, `[^<>&/\[\]\x00-\x20=]`. The
  payload still cannot carry markup or an attribute. Alpaca Bot's own tags did not need the
  change. It was made because the old class turned legal registrations into false defects.
- **`accessMatrix` uses role capabilities.** As expected; it did not bite.

## Open questions, for a decision

1. **A plugin's deliberate deprecation notice (finding 7).** `[alpacabot_agent]` is a documented
   shim. `AgentShim::deprecate()` calls `_doing_it_wrong()` once per request on purpose, and the
   notice is real. The runner renders every registered shortcode, so the row is red on every run
   for a reason the author chose. The notice is not a defect. Separately, its wording ("Function
   alpacabot_agent was called incorrectly") misnames a shortcode as a function; that is core's
   `_doing_it_wrong` template.

   A blanket rule suppressing "called incorrectly" would hide real misuse, so the runner needs to
   be told. Options:
   - **(a)** A manifest declaration such as `"deprecated": { "shortcodes": ["alpacabot_agent"] }`.
     The discovered render still runs, but a deprecation or `_doing_it_wrong` notice naming that
     tag is not counted.
   - **(b)** A manifest `skip` list, so the tag becomes a visible per-tag skip.
   - **(c)** Keep the red, and accept it until the shim is removed.

   Recommended: **(a)**. It keeps the shim's render exercised, and any other notice from it still
   fails.
2. **Orphan detection after `wph mount` (finding 5).** Every workflow that mounts with wp-harness
   activates the plugin before the baseline, so the lifecycle journey is blind to whatever the
   plugin creates on activation or first `init`. That is precisely the state an uninstall routine
   should remove. It cannot be made complete from inside the run. Options:
   - a documented "fresh site per plugin" workflow;
   - the lifecycle row stating that its orphan check was partial when the plugin was already
     active at the baseline;
   - both.
3. **`manifest.gate` is parsed and never read (finding 14).** The runner activates the plugin
   itself, so the gate's original meaning ("run only when the plugin is live") has no job. It
   could instead assert that `gate.screen` is among the discovered screens, or be removed from
   the schema.
4. **Render as anonymous.** The spec's core-suite step 5 says to render every block and shortcode
   "anonymously and logged in". The discovered-surface render journeys run as administrator only.
   A manifest can add an anonymous render, as Alpaca Bot's does.
