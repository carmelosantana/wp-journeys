# False greens

A false green is a row that reads `ok` when the check behind it caught nothing, or could not
have caught anything. It is worse than a red row, because nobody looks at it again. Every entry
below happened in this codebase, or was one line of code away from happening. Each one is
now guarded, and the entry names the guard so you can tell if someone removes it.

**The binding constraint.** A skipped or lost signal is never reported as ok. A skip is never
rendered as a pass. An expected denial is a pass only when the page was denied for the right
reason.

## The table

| False green | Why it passes while catching nothing | The instance here | The guard |
|---|---|---|---|
| A sentinel that watches only the HTTP status | A PHP warning comes back with a 200. **The notice is the WordPress bug.** | `_doing_it_wrong` from `[alpacabot_agent]` rendered a normal-looking page with a 200. | The `phplog` signal reads `debug.log` on every journey. `bodyscan` catches diagnostics printed into the HTML. |
| A console signal trusted to catch a script that throws | The browser never reports an uncaught exception or an unhandled rejection as a console message, so an admin screen whose plugin script throws on load read as `ok`. | The final review: a page running `undefinedPluginGlobal.init()` and a bare `Promise.reject(...)` produced no finding at all. | A separate `pageerror` signal records both, and is never subtracted as baseline noise. The canary proof arms a throwing script and requires a `pageerror` naming it. |
| A body scan that cannot see a notice printed before the markup | The HTML parser moves leading text to just after an implied `<body>`, so a pattern anchored at `^` never matches. With `WP_DEBUG_LOG` off, this is the **only** signal. | First contact, finding 3: `scanBody(raw): 1`, `scanBody(dom): 0`. | The plain-text form also matches directly after `<body>`, and is kept to a single line. |
| A journey that always skips, shown as `ok` | The plugin was never exercised, and nobody could tell. | `block-render` on a plugin that registers no blocks. A row whose every block is static proves only that the blocks are registered. | `skip` is its own label, and its reason is printed. Coverage prints `X of Y`, so skips never count as coverage (R58). A row of only static blocks is a skip (R78). |
| A half-declared skip | `skipReason` is set but `skipped` is not `true`. Nothing downstream can tell that from a clean run. | R39. | `outcomeOf` throws, and the runner turns the throw into a FAIL for that one journey. |
| A manifest silently ignored because it failed to parse | The author believes their journeys ran. | A typo in a key, an empty `screens: []`, a screen that names neither the journey's actor nor the right list. | Every schema problem throws, naming the file and the index. Unknown keys are refused. |
| A manifest silently not loaded | Same result as the row above, one level up. | `WPJ_PLUGIN_DIR` was set to the mount path, while the manifest lived in `tests/e2e` (R70). | The old variable name is refused. So are an empty `WPJ_MANIFEST_DIR`, a named directory with no manifest in it, and a manifest written for another plugin. |
| Trusting a 2xx on a write | A validation or capability failure redirects back to the form with a 200. It does not produce a 5xx. | First contact, finding 8: Enter in a `<textarea>` never posted the form. | Settings are read back on the frontend. The text must be absent before the write and present after it. |
| A read-back that matches an old value | After the first successful run, the value is on the site for good, so a submit that later breaks stays green. | R66. | Each write gets a fresh `wpj-<8 hex>` suffix, and must be absent before it is written. |
| A lost `debug.log` signal reported as an empty delta | An empty delta looks exactly like "nothing went wrong". | The log is unreadable, rotated, or `WP_DEBUG_LOG` is off. | `debug.log signal unavailable (…) — PHP diagnostics in this window were NOT read` is a `phplog` **finding**. An unreadable body is a `bodyscan` finding, and a request that cannot be classified is recorded as a lost signal. |
| Discovery without a deactivated baseline | Another plugin's screens and deprecations get attributed to yours, or they hide yours. | Every site has other plugins' menus and per-request deprecation noise. | `captureBaseline` deactivates the plugin **before** it snapshots, and the suite drives only the delta. Log noise the site emits with the plugin off is subtracted (R45). |
| A refused login token read as a session (R54) | Every denial a journey expects is **also** satisfied by the login redirect. So a sweep whose login was silently refused runs as an anonymous visitor, and it passes for four of the six actors. | Task 11. | A refused token is a loud 403. A URL that still carries the token after the login means no session. Every logged-in sweep and step-based journey first requires that `/wp-admin/profile.php` is **served**. |
| An orphan check blind after an activating mount (R75) | `wph mount` activates the plugin, and the first request writes its state. That state is in the baseline, so the uninstall diff cannot see it. | First contact, run 1: `lifecycle: ok` while four `alpaca_bot_migrated_*` options survived. | If the plugin was active at the start, `lifecycle` is a **skip**. A passing row carries a note that it assumes a never-activated site. |
| A cron handler trusted without checking where it came from (R79) | A plugin's leftover mu-plugin answers the plugin's own orphaned hook, so "something handles it" read as "core handles it". | The first fix used `has_action()`. | A hook is excluded as core's only when **every** callback on it is defined under `wp-includes` or `wp-admin`. `lifecycle` fails if the plugin is still active, or if the agent cannot say whether it is. |
| A non-2xx main document treated as content | A 502 page from a stopped container, or a 404 from a mistyped URL, still renders text that content assertions can match. | Plan revision, 2026-09-09. | `sentinel.visit` asserts the document's status through `classifyNavigation`. Journeys never call `page.goto`. |
| "Ignore all 4xx" | An **unexpected** 403 is a permission bug, and it would pass. | A tempting shortcut. | `classifyNavigation` accepts 401, 403 or the login redirect **only** when the visit declared `denyExpected`. A 200 on a declared denial is an access hole. A 404 or 5xx on a declared denial is still a finding. |
| A sticky expectation | Once a journey declares one denial, every later screen accepts a 403. | R40. | `expect()` is one-shot. `visit()` consumes it and reverts to strict. |
| A sentinel shared by two journeys | The sentinel de-duplicates what it reports, so journey 2's genuine 5xx on a URL that journey 1 already reported disappears. | The `Sentinel` contract. | One sentinel per journey, on a fresh page (`runAsActor`). |
| A run that registered nothing | `0 passed, 0 failed` reads like a clean run, and exit 0 is what CI believes. | The exit-code floor. | Zero journeys exits 1, and the summary says so. |
| A declared deprecation that hides other findings | A discount for one tag swallows a notice about a different tag, or a real warning. | R74, R80. | Each declared tag renders on its own row. Only a Notice or Deprecated from `wp-includes/functions.php` that names **that** tag is discounted, and the row says so. |
| A module with no sentinel | `browser.newPage()` in an escape hatch has no signals armed and no login proven. | The escape-hatch contract. | Use `runAsActor` (see escape-hatch.md). |

## An expected denial, for the right reason

A denial is evidence only when all three of these hold:

1. **The session is real.** A served control visit (`/wp-admin/profile.php`) must come first.
   Otherwise the login redirect satisfies the denial for a visitor who was never logged in.
2. **The denial is a denial.** It must be a 401, a 403, or WordPress's login redirect. A 404
   (wrong URL), a 5xx (a crash), or a `wp_die` page with a 200 status is not a denial.
3. **The denial was declared for this visit.** An undeclared 403 is a failure.

The permission matrix decides which actors are denied from the site's **real** capability
map, taken with the plugin active. A map built from the delta alone reports only the
capabilities the plugin *added*. That would expect the administrator to be denied its own
screen, which inverts the whole sweep.

## Before you call something green

- Did every row in the header count as passed, or were some skipped? Quote all three numbers.
- Does any row carry a `·` note? The pass depends on what the note says.
- Was `debug.log` available? Check with the MCP `status` tool, or look for `signal unavailable`.
- Was the plugin inactive, on a never-activated site, when the run started?
- For a read-back: did the text you wrote appear, or only text like it?
