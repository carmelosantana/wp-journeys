# First contact: Alpaca Bot

> **A lab notebook.** This page is the record of wp-journeys' first run against a real plugin,
> Alpaca Bot, which is the author's own. It is kept for what it taught the runner, not as a report
> on that plugin: the Alpaca Bot defect it records is known to, and tracked by, the plugin's
> author.

The first run of wp-journeys against a real plugin: Alpaca Bot 0.5.0 (`develop`), mounted on the
scratch site `wpjtest` (WordPress 7.1, PHP 8.4). Tasks 1-13 built the runner against a synthetic
fixture. This page records what the contract got wrong when it met a real plugin, and what was
done about each finding.

Every output below is the runner's real stdout, copied verbatim. Each run is labelled with the
commit the runner was at. The labels were established from the saved output files' modification
times against the commit times; each run finished after the labelled commit and before the next
one. An earlier revision of this page mislabelled Run 2 as `33b6d48`. That cannot be right,
because at `33b6d48` every summary prints a `discovered:` block and Run 2's has none. Run 2
finished at 10:08:38, between `c710d86` (10:06:48) and `33b6d48` (10:09:29). Nothing in any of these runs
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
| 1 | The mount path and the manifest directory are two different paths | Contract gap (R70) | `WPJ_PLUGIN_DIR` renamed `WPJ_MANIFEST_DIR`. Refused: the old name, the variable set to an empty string, a named directory holding no manifest, and a manifest for another plugin. `interpret()` now requires the directory. Commits `1ee50bc`, `e396042` |
| 2 | `[alpacabot_agent]` reported as "came back verbatim" when it had expanded | Runner false red | The agent now reports expansion (`data-wpj-expanded`); the runner no longer guesses from the text. Commit `c710d86` |
| 3 | A PHP notice printed before any markup was invisible to the body scan | Runner lost signal (false green when `debug.log` is off) | The plain-text form now also matches directly after `<body>`. Commit `39a62f8` |
| 4 | The summary never named the discovered surface | Contract gap | The summary lists the screens, shortcodes and blocks the run attributed to the plugin. Commit `33b6d48` |
| 5 | The lifecycle journey reported `ok` while four options survived the uninstall | Runner false green, the known R7a limit made real by the workflow | **Resolved (R75).** A baseline taken with the plugin active makes the row a visible skip; orphans found anyway stay red; a pass states its precondition. Commit `448a87f`; proven live in run 10 |
| 6 | Alpaca Bot has no uninstall routine | **Alpaca Bot defect** | Reported below |
| 7 | `[alpacabot_agent]` emits a deliberate `_doing_it_wrong` deprecation notice whenever it renders | Contract gap | **Resolved (R74, R80).** A manifest may declare `deprecated.shortcodes`. A declared tag renders on its own row, where only core's deprecation notice naming it is discounted, and the row says so. Commit `e396042`; proven live in runs 7 and 9 |
| 8 | The plugin's only setting that appears on the frontend is a `<textarea>`, and Enter does not submit one | Contract gap (proven live, run 3) | Optional `submit` selector on a settings entry, clicked once. Commit `7bac8b4` |
| 9 | A failed read-back did not name "the readBack page does not show this setting" as a cause | Runner message error (Step 6) | Commit `642c1e7` |
| 10 | Blocks were discovered and never rendered | Contract gap (R57, then R78) | New `block-render` journey behind a guarded block door (`5644848`). A static block is a named note, not a pass, and a row whose every block is static is a skip (`ca1c490`). It skips for Alpaca Bot, which registers no blocks |
| 11 | A core cron event scheduled lazily between the baseline and the uninstall is blamed on the plugin | Runner false red (carried from Task 11, seen live in Task 12) | First fixed in `cac2f9b` with an EXISTENCE check (`has_action`). Review found that check was itself a false green: a plugin's leftover mu-plugin answers its own orphaned hook. **Corrected (R79)** in `565abbc`: a hook is excluded only when every callback is defined under wp-includes or wp-admin, and lifecycle refuses a plugin that is still active |
| 12 | The render door refused shortcode tags that core accepts | Runner false red, latent | Widened to core's own forbidden class (`4bd60b9`). Alpaca Bot's tags did not need it. The widened gate lets `"` and a no-break space through; what keeps them from acting as attributes is core's exact-name pre-filter, now proven live (`3570471`) |
| 13 | A read-back failure was always called "no HTML body" | Runner message error (Task 13, parked) | Only a Playwright `TimeoutError` gets that diagnosis. Commit `7466414` |
| 14 | `manifest.gate` is parsed and never consulted | Contract gap | **Resolved (R76).** Checked once before any authored journey; if the administrator is not served it, every authored journey fails naming the gate. Commit `8cec1ca`; proven live both ways in runs 7 and 8 |
| 15 | `accessMatrix` judges role capabilities, not effective ones | Known, expected | Not triggered: both Alpaca Bot screens are gated by plain role capabilities (`edit_posts`, `manage_options`) |
| 16 | Conflicting expectations for one URL (R56) | Known | Not triggered: Alpaca Bot's top-level menu mirrors itself, so it is not promoted |
| 17 | The discovered renders ran only as administrator; the spec says "anonymously and logged in" | Contract gap | **Resolved (R77).** Shortcode and block renders run as administrator AND anonymous, and declare the frontend, the only surface they touch. Commit `ca1c490` |
| 18 | The plain-text body match could span lines from body-first prose to a later `in <x> on line <n>` | Runner false red, latent (review) | Kept to one line. Commit `175ea9d` |

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
- Setting `WPJ_MANIFEST_DIR` to the empty string is refused. (Until `e396042` it was silently
  read as unset.)
- A named directory with no `wp-journeys.json` in it is refused. The likeliest mistake is naming
  the plugin root, and it used to read as "this plugin has no manifest".
- A manifest whose `plugin` field is not the `--plugin` slug is refused.

`interpret()`'s directory argument has no default any more. Its old `'.'` default silently
resolved module paths against the runner's working directory. The compiler caught the four call
sites that omitted it.

The manifest is loaded before the baseline, so a manifest that cannot run costs no deactivate and
no suite. Since `e396042`, that includes an authored journey name that collides with a core one;
before, that collision was refused only inside `coreSuite`, after the baseline had already
toggled the plugin. Authored journeys run after the discovered-surface journeys and before `lifecycle`,
because `lifecycle` uninstalls the plugin every other journey needs.

The working invocation:

```bash
WPH="${WPH:-wph}"                              # the wp-harness CLI
$WPH mount wpjtest plugin alpaca-bot "$HOME/Projects/Alpaca Bot/wp-alpaca/plugins/alpaca-bot"
set -a; . ./.env; set +a                       # WPJ_BASE_URL, WPJ_AGENT_SECRET
export WPJ_WP="$WPH wp wpjtest --"
export WPJ_MANIFEST_DIR="$HOME/Projects/Alpaca Bot/wp-alpaca/plugins/alpaca-bot/tests/e2e"
node bin/wpj.js run --plugin alpaca-bot
```

### The fresh-site workflow (R75)

The orphan check is sound only when the plugin under test has **never been activated** on the
site. Anything an earlier activation created is already in the baseline, and a diff against it
cannot see it. That is exactly the state an uninstall routine exists to remove. So:

1. Use a site where the plugin has never run. The simplest is a new scratch site per plugin.
2. Make sure the plugin is **inactive** when the run starts. The runner records whether it was
   active before its own deactivate. If it was, the lifecycle row is a visible **skip**, not a
   pass (orphans it finds anyway still fail).
3. **`wph mount` alone is not such a workflow: it activates the plugin it mounts.** The first
   `init` after that activation writes whatever the plugin writes; for Alpaca Bot, four
   `alpaca_bot_migrated_*` options. After mounting, deactivate the plugin and remove that state
   before the first run, or mount it on a site that will be thrown away after one run.

On this task's runs 2 to 9, wpjtest was put back in that state by hand before each run: the
plugin deactivated, and its `alpaca_bot_*` options, cron event and user meta deleted. A passing
lifecycle row now says the precondition it rests on.

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
now emits `data-wpj-expanded="1"` when `do_shortcode()` changed its input, and `"0"` when it
returned it unchanged. A marker without the flag fails; the runner never falls back to the guess. After the
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

## Run 2: never-activated baseline, runner at `c710d86`

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

## Run 3: with the manifest, current contract, runner at `7466414` (Step 4)

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

## Run 4: with `submit`, runner at `7bac8b4` (Step 5)

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

## Run 5: the read-back can fail, runner at `7bac8b4` (Step 6)

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

## Run 6: restored manifest, runner at `642c1e7` (Step 6 confirmation)

The manifest was restored, then compared byte for byte with the saved copy before it was
committed. Exit 1. All four authored journeys pass. The two remaining reds are finding 6 (a
genuine defect) and finding 7 (a deliberate deprecation notice, open at the time and resolved in
fix round 1).

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

### The manifest as first committed (`b7ccf1f`)

On the Alpaca Bot branch `wp-journeys/first-contact`, local only, at
`tests/e2e/wp-journeys.json`. Fix round 1 amended it (`54d797f`); see below.

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
  string rather than an error. It also reports `data-wpj-dynamic`. Proven live on the fixture's
  dynamic block, with a red case for an unregistered name. Fix round 1 (R78) narrowed what a
  static block may claim; see below.
- **Lazy core cron.** Solved by re-checking the hook's ORIGIN (as corrected by R79 in fix
  round 1). The snapshot carries `cronCore`: the scheduled hooks whose every callback is defined
  under `wp-includes` or `wp-admin`. It also carries `pluginActive` for the plugin under test.
- **The shortcode tag class.** Widened deliberately to core's rule, `[^<>&/\[\]\x00-\x20=]`. See
  finding 12 for what keeps an attribute out.
- **`accessMatrix` uses role capabilities.** As expected; it did not bite.

## Fix round 1

The review found one Critical, three Important and six minor issues, and the four questions this page
left open were ruled (R74 to R80). Each change below had a failing test first.

### R79, Critical: the cron exclusion trusted any handler

The first fix (`cac2f9b`) excluded a new cron hook whenever `has_action()` said something
answered it. A plugin that leaves loadable code behind (an mu-plugin or drop-in it wrote, or
files another active plugin includes) answers its own orphaned hook after the uninstall, and
lifecycle went green. That is the false green in exactly the defect class the row exists for.

Now the agent resolves every callback on the hook by reflection: function names,
`Class::method` strings, `[object|class, method]` arrays, closures and invokable objects. A hook
is core's only when it has callbacks and every one is defined under `ABSPATH . WPINC` or
`ABSPATH . 'wp-admin'`. A callback that cannot be resolved counts as not core. The PHP tests
cover all six shapes both inside and outside a fake core tree, a hook with one core and one
non-core callback, a PHP built-in, and a sibling directory that shares the prefix.

The post-uninstall snapshot also says whether the plugin is still active. Lifecycle fails if it
is, and also fails if the agent cannot say. Live, with Alpaca Bot inactive:

```
cron 12 core 12 NOT core: (none) | pluginActive false
```

With Alpaca Bot active, its own hook is answered by plugin code, so it is not core:

```
cron 13 core 12 NOT core: alpaca_bot/usage/cleanup | pluginActive true
```

The fixture's known leak (`wpj_fixture_daily`) is still caught (conformance e2e, 23/23).

### R78: what a block render can prove

The block door exits before `wp_head` and `wp_footer`, so no frontend asset is exercised. A row
with a dynamic block now says so. A static block's frontend output is its saved post content,
which the door cannot produce, so each static block is a named note. A row whose every block is
static is a skip, never a bare ok.

### R77: anonymous renders

The discovered shortcode and block renders now run as `administrator` and `anonymous`, named
`shortcode-render:<plugin>:<actor>` and `block-render:<plugin>:<actor>`. They declare the
frontend, the only surface they touch, so admin coverage no longer counts them. (Run 7 reads
`admin: 10 of 10`: six sweeps, the lifecycle row and three authored journeys.)

### R74 and R80: a declared deprecation, attributed to one tag

`"deprecated": { "shortcodes": ["alpacabot_agent"] }` declares a tag the plugin deprecates on
purpose. Only a finding that meets all of the following is discounted:

- it came from the log or the body scan;
- its severity is Notice or Deprecated;
- it was raised in `wp-includes/functions.php` (core's `_doing_it_wrong` / `_deprecated_*`
  helpers);
- its subject IS the tag, or its text quotes `[tag]`.

Everything else on that render stays red. Undeclared deprecations stay red; run 10 shows
`[alpacabot_agent]` failing both grouped rows when the manifest is absent. A manifest journey may
not list a declared tag in its own `shortcodes`; the schema refuses it.

**The R80 choice: one journey per declared tag, not per-visit log deltas.** Each declared tag
renders in its own journey, per actor, named `shortcode-render:<plugin>:<actor>:[<tag>]`.
Undeclared tags stay together on the grouped row.

- That journey has its own sentinel (R44 unchanged) and its own log window, so every finding on
  it came from that one render.
- The discount runs over that journey's findings only. A declaration therefore cannot reach
  another tag's render: tests prove that a notice naming a second declared tag, emitted on the
  first tag's row, stays red.
- Per-visit log deltas were rejected. They would have changed the sentinel's settle/truncate
  logic (R43, R46) for one feature.

The row says what it discounted, or that the notice it was declared for never came.

### R76: the gate

`gate.screen` is a plugin page slug (served at `admin.php?page=<slug>`) or a URL starting with
`/`. Before the first authored journey, the administrator must be served it cleanly. The check
runs once per manifest, and if the gate does not hold, every authored journey fails naming it.
Alpaca Bot's manifest gates on `alpaca-bot`, the chat screen.

### Minors

- The render gate's comment no longer claims the payload cannot carry an attribute.
- `WPJ_MANIFEST_DIR=""` is refused.
- An authored/core name collision is refused before the site is touched.
- A whitespace-only `submit` is refused.
- The plain-text body match is kept to one line. The cost: a plain-text diagnostic whose own
  message contains a newline is no longer caught in the body. The `Uncaught` branch and the log
  signal still catch those.
- The render journeys declare `frontend`.

### Run 7: runner at `3570471`, amended manifest, never-activated baseline

Exit 1. The only red is the genuine defect (finding 6).

```
18 journeys: 15 passed, 1 failed, 2 skipped — coverage admin: 10 of 10, frontend: 7 of 9
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
  ok       shortcode-render:alpaca-bot:administrator (administrator/frontend) entitiesCreated=0
  ok       shortcode-render:alpaca-bot:administrator:[alpacabot_agent] (administrator/frontend) entitiesCreated=0
      · discounted 2 deprecation notices naming [alpacabot_agent], which the manifest declares deprecated (deprecated.shortcodes)
  ok       shortcode-render:alpaca-bot:anonymous (anonymous/frontend) entitiesCreated=0
  ok       shortcode-render:alpaca-bot:anonymous:[alpacabot_agent] (anonymous/frontend) entitiesCreated=0
      · discounted 2 deprecation notices naming [alpacabot_agent], which the manifest declares deprecated (deprecated.shortcodes)
  skip     block-render:alpaca-bot:administrator (administrator/frontend) entitiesCreated=0 — skipped (alpaca-bot registered no blocks)
  skip     block-render:alpaca-bot:anonymous (anonymous/frontend) entitiesCreated=0 — skipped (alpaca-bot registered no blocks)
  ok       alpaca-bot-welcome-round-trip (administrator/both) entitiesCreated=0
  ok       alpaca-bot-editor-chats-but-cannot-configure (editor/admin) entitiesCreated=0
  ok       alpaca-bot-subscriber-cannot-chat (subscriber/admin) entitiesCreated=0
  ok       alpaca-bot-shortcode-for-a-visitor (anonymous/frontend) entitiesCreated=0
  FAIL(1)  lifecycle:alpaca-bot (administrator/admin) entitiesCreated=0
      - [assertion] alpaca-bot left state behind after uninstall: options=alpaca_bot_migrated_04, alpaca_bot_migrated_04_conversations, alpaca_bot_migrated_flag_autoload, alpaca_bot_migrated_retention, alpaca_bot_settings; tables=none; cron=none; userMeta=none
```

### Run 8: the gate can fail, runner at `3570471`

The gate was temporarily set to `alpaca-bot-not-a-screen`. Exit 1. Every authored journey failed
naming the gate, and none of their steps ran. There was no settings write, so no
`alpaca_bot_settings` orphan.

```
18 journeys: 11 passed, 5 failed, 2 skipped — coverage admin: 10 of 10, frontend: 7 of 9
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
  ok       shortcode-render:alpaca-bot:administrator (administrator/frontend) entitiesCreated=0
  ok       shortcode-render:alpaca-bot:administrator:[alpacabot_agent] (administrator/frontend) entitiesCreated=0
      · discounted 2 deprecation notices naming [alpacabot_agent], which the manifest declares deprecated (deprecated.shortcodes)
  ok       shortcode-render:alpaca-bot:anonymous (anonymous/frontend) entitiesCreated=0
  ok       shortcode-render:alpaca-bot:anonymous:[alpacabot_agent] (anonymous/frontend) entitiesCreated=0
      · discounted 2 deprecation notices naming [alpacabot_agent], which the manifest declares deprecated (deprecated.shortcodes)
  skip     block-render:alpaca-bot:administrator (administrator/frontend) entitiesCreated=0 — skipped (alpaca-bot registered no blocks)
  skip     block-render:alpaca-bot:anonymous (anonymous/frontend) entitiesCreated=0 — skipped (alpaca-bot registered no blocks)
  FAIL(1)  alpaca-bot-welcome-round-trip (administrator/both) entitiesCreated=0
      - [assertion] journey "alpaca-bot-welcome-round-trip": gate "alpaca-bot-not-a-screen" failed: the administrator was not served /wp-admin/admin.php?page=alpaca-bot-not-a-screen cleanly — navigation to https://wpjtest.wp.test/wp-admin/admin.php?page=alpaca-bot-not-a-screen returned HTTP 403 — the journey required a document it could act on
  FAIL(1)  alpaca-bot-editor-chats-but-cannot-configure (editor/admin) entitiesCreated=0
      - [assertion] journey "alpaca-bot-editor-chats-but-cannot-configure": gate "alpaca-bot-not-a-screen" failed: the administrator was not served /wp-admin/admin.php?page=alpaca-bot-not-a-screen cleanly — navigation to https://wpjtest.wp.test/wp-admin/admin.php?page=alpaca-bot-not-a-screen returned HTTP 403 — the journey required a document it could act on
  FAIL(1)  alpaca-bot-subscriber-cannot-chat (subscriber/admin) entitiesCreated=0
      - [assertion] journey "alpaca-bot-subscriber-cannot-chat": gate "alpaca-bot-not-a-screen" failed: the administrator was not served /wp-admin/admin.php?page=alpaca-bot-not-a-screen cleanly — navigation to https://wpjtest.wp.test/wp-admin/admin.php?page=alpaca-bot-not-a-screen returned HTTP 403 — the journey required a document it could act on
  FAIL(1)  alpaca-bot-shortcode-for-a-visitor (anonymous/frontend) entitiesCreated=0
      - [assertion] journey "alpaca-bot-shortcode-for-a-visitor": gate "alpaca-bot-not-a-screen" failed: the administrator was not served /wp-admin/admin.php?page=alpaca-bot-not-a-screen cleanly — navigation to https://wpjtest.wp.test/wp-admin/admin.php?page=alpaca-bot-not-a-screen returned HTTP 403 — the journey required a document it could act on
  FAIL(1)  lifecycle:alpaca-bot (administrator/admin) entitiesCreated=0
      - [assertion] alpaca-bot left state behind after uninstall: options=alpaca_bot_migrated_04, alpaca_bot_migrated_04_conversations, alpaca_bot_migrated_flag_autoload, alpaca_bot_migrated_retention; tables=none; cron=none; userMeta=none
```

### Run 9: gate restored, runner at `3570471`

The manifest was restored and compared byte for byte with the saved copy before it was
committed. Exit 1, for the defect only.

```
18 journeys: 15 passed, 1 failed, 2 skipped — coverage admin: 10 of 10, frontend: 7 of 9
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
  ok       shortcode-render:alpaca-bot:administrator (administrator/frontend) entitiesCreated=0
  ok       shortcode-render:alpaca-bot:administrator:[alpacabot_agent] (administrator/frontend) entitiesCreated=0
      · discounted 2 deprecation notices naming [alpacabot_agent], which the manifest declares deprecated (deprecated.shortcodes)
  ok       shortcode-render:alpaca-bot:anonymous (anonymous/frontend) entitiesCreated=0
  ok       shortcode-render:alpaca-bot:anonymous:[alpacabot_agent] (anonymous/frontend) entitiesCreated=0
      · discounted 2 deprecation notices naming [alpacabot_agent], which the manifest declares deprecated (deprecated.shortcodes)
  skip     block-render:alpaca-bot:administrator (administrator/frontend) entitiesCreated=0 — skipped (alpaca-bot registered no blocks)
  skip     block-render:alpaca-bot:anonymous (anonymous/frontend) entitiesCreated=0 — skipped (alpaca-bot registered no blocks)
  ok       alpaca-bot-welcome-round-trip (administrator/both) entitiesCreated=0
  ok       alpaca-bot-editor-chats-but-cannot-configure (editor/admin) entitiesCreated=0
  ok       alpaca-bot-subscriber-cannot-chat (subscriber/admin) entitiesCreated=0
  ok       alpaca-bot-shortcode-for-a-visitor (anonymous/frontend) entitiesCreated=0
  FAIL(1)  lifecycle:alpaca-bot (administrator/admin) entitiesCreated=0
      - [assertion] alpaca-bot left state behind after uninstall: options=alpaca_bot_migrated_04, alpaca_bot_migrated_04_conversations, alpaca_bot_migrated_flag_autoload, alpaca_bot_migrated_retention, alpaca_bot_settings; tables=none; cron=none; userMeta=none
```

### Run 10: Alpaca Bot active before the run, no manifest, runner at `3570471` (R75)

Alpaca Bot was activated and served one request (which wrote its four migration flags) before
the runner started. The lifecycle row is a visible skip where Run 1 read `ok`. Undeclared, the
deprecation notice fails both grouped shortcode rows. Exit 1.

```
12 journeys: 7 passed, 2 failed, 3 skipped — coverage admin: 6 of 7, frontend: 3 of 5
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
  FAIL(2)  shortcode-render:alpaca-bot:administrator (administrator/frontend) entitiesCreated=0
      - [bodyscan] PHP Notice printed into the response body at https://wpjtest.wp.test/?wpj_render=%5Balpacabot_agent%5D: Function alpacabot_agent was called incorrectly. The [alpacabot_agent] shortcode is deprecated since 0.5.0 and goes away in a later 0.x release. It still fetches its URL and, for summarize, asks the model. Put the text to work on in the prompt of [alpacabot prompt="Summarize the following: …"] instead, or open the URL in the chat screen, where the web_fetch and summarize tools read it for you. Please see Debugging in WordPress for more information. (This message was added in version 0.5.0.) in /var/www/html/wp-includes/functions.php on line 6260
      - [phplog] PHP Notice: Function alpacabot_agent was called incorrectly. The [alpacabot_agent] shortcode is deprecated since 0.5.0 and goes away in a later 0.x release. It still fetches its URL and, for summarize, asks the model. Put the text to work on in the prompt of [alpacabot prompt="Summarize the following: …"] instead, or open the URL in the chat screen, where the web_fetch and summarize tools read it for you. Please see Debugging in WordPress for more information. (This message was added in version 0.5.0.) in /var/www/html/wp-includes/functions.php on line 6260
  FAIL(2)  shortcode-render:alpaca-bot:anonymous (anonymous/frontend) entitiesCreated=0
      - [bodyscan] PHP Notice printed into the response body at https://wpjtest.wp.test/?wpj_render=%5Balpacabot_agent%5D: Function alpacabot_agent was called incorrectly. The [alpacabot_agent] shortcode is deprecated since 0.5.0 and goes away in a later 0.x release. It still fetches its URL and, for summarize, asks the model. Put the text to work on in the prompt of [alpacabot prompt="Summarize the following: …"] instead, or open the URL in the chat screen, where the web_fetch and summarize tools read it for you. Please see Debugging in WordPress for more information. (This message was added in version 0.5.0.) in /var/www/html/wp-includes/functions.php on line 6260
      - [phplog] PHP Notice: Function alpacabot_agent was called incorrectly. The [alpacabot_agent] shortcode is deprecated since 0.5.0 and goes away in a later 0.x release. It still fetches its URL and, for summarize, asks the model. Put the text to work on in the prompt of [alpacabot prompt="Summarize the following: …"] instead, or open the URL in the chat screen, where the web_fetch and summarize tools read it for you. Please see Debugging in WordPress for more information. (This message was added in version 0.5.0.) in /var/www/html/wp-includes/functions.php on line 6260
  skip     block-render:alpaca-bot:administrator (administrator/frontend) entitiesCreated=0 — skipped (alpaca-bot registered no blocks)
  skip     block-render:alpaca-bot:anonymous (anonymous/frontend) entitiesCreated=0 — skipped (alpaca-bot registered no blocks)
  skip     lifecycle:alpaca-bot (administrator/admin) entitiesCreated=0 — skipped (alpaca-bot was already active when the baseline was taken, so state its activation created predates the baseline and its leftovers are invisible — run on a site where it was never activated)
```

### The manifest as committed now (`54d797f`)

```json
{
  "description": "wp-journeys manifest for Alpaca Bot. Run with WPJ_MANIFEST_DIR pointing at this directory (tests/e2e), not at the plugin root. JSON, so the plugin's own Playwright run does not collect it.",
  "version": 1,
  "plugin": "alpaca-bot",
  "gate": { "screen": "alpaca-bot" },
  "deprecated": { "shortcodes": ["alpacabot_agent"] },
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

## What remains

- **Finding 6 is Alpaca Bot's to fix:** it needs an uninstall routine. The last runs stay red on
  it, as they should.
- **R75 is a mitigation, not a cure.** A plugin that was activated and then deactivated before a
  run still leaves state in the baseline, and the runner cannot tell. The skip covers only a
  plugin that is active at the start.
