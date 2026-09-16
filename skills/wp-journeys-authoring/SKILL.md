---
name: wp-journeys-authoring
description: Use when writing or editing a wp-journeys.json manifest for a WordPress plugin, adding a settings round-trip (write in wp-admin, read back on the frontend), expressing that an actor must be denied a screen, declaring a deliberately deprecated shortcode, gating journeys on the plugin being live, reaching for a TypeScript escape-hatch journey module, or judging whether a green wp-journeys result actually proved anything (false greens, skips, lost signals, expected denials).
---

# Authoring wp-journeys

## Overview

A manifest adds the plugin's **own** journeys to the core suite. **The binding constraint:** a skipped or lost signal is never reported as ok, a skip is never rendered as a pass, and an expected denial counts as a pass only when it is denied for the right reason. Before you trust any green row, read [false greens](references/false-greens.md).

## Where it goes

Put `wp-journeys.json` in any directory of the plugin, for example `tests/e2e/`, and run with `WPJ_MANIFEST_DIR` pointing at **that** directory. It need not be the plugin root. The copy-ready example is [assets/wp-journeys.json](assets/wp-journeys.json).

## Manifest fields

| Field | Meaning |
|---|---|
| `version` | Always `1`. |
| `plugin` | The slug. It must equal the run's `--plugin`, or the run is refused. |
| `description`, `$schema` | Free text, and editor completion. The runner ignores both. |
| `gate.screen` | Optional. A plugin page slug (served as `admin.php?page=<slug>`) or a `/path`. The administrator must be served it cleanly, or **every** authored journey fails. |
| `deprecated.shortcodes` | Optional. Tags the plugin deprecates on purpose. Each one renders on its own row, and core's deprecation notice naming that tag is discounted there, with a note. A journey may not also list a declared tag. |
| `journeys[]` | Non-empty. Names must be unique and must not collide with a core row. |

| Journey field | Meaning |
|---|---|
| `name`, `actor`, `surface` | `actor` is one of `anonymous`, `subscriber`, `contributor`, `author`, `editor`, `administrator`. `surface` is `admin`, `frontend` or `both`. |
| `screens[]` | `{url, allow, deny}`. The journey's actor must appear in **exactly one** of the two lists. `deny` means a 401, a 403 or the login redirect is the pass. |
| `settings[]` | `{url, field, value, readBack, submit?}`. The runner writes `value` plus a fresh `wpj-<8 hex>` suffix into `field` on `url`, submits once, and then requires that exact text to be **absent** at `readBack` before the write and **visible** there after it. |
| `settings[].submit` | A CSS selector for the control to click, once. Without it the runner presses Enter, which never submits a `<textarea>`. |
| `shortcodes[]` | Tags rendered through the agent's render door. A tag must expand; a tag returned unchanged fails the journey. |
| `module` | A path, relative to the manifest directory and confined inside it, to a TypeScript file that default-exports a `Journey`. It **replaces** the steps, so it cannot be combined with them. See [escape hatch](references/escape-hatch.md). |

Every step-based journey for a logged-in actor first visits `/wp-admin/profile.php` as a control. The visit must be served, which proves the session is real before any denial is believed. A module gets no control visit unless it makes one.

Every schema problem is refused loudly, by name. Fix the message; never work around it.

## Common mistakes

| Mistake | Fix |
|---|---|
| Expecting `deny` to be satisfied by a 404 or a 5xx | Only a 401, a 403 or the login redirect counts as a denial. A 404 means the URL is wrong, and the journey fails. |
| `readBack` pointing at a page that never shows the setting | Point it at a frontend URL that renders the value, e.g. `/?wpj_render=%5Btag%5D`. Write it unsigned: the runner signs a render-door path for you at each visit. |
| A `readBack` page that already shows the written text | The journey fails before it writes anything, because the text appearing afterwards would prove nothing. |
| A module that calls `browser.newPage()` itself | Use `runAsActor`. Without it no sentinel is armed and no session is proven. |

Running the suite and reading its output are covered by **wp-journeys-running**.
