# Dependency vet — 2026-09-09

Run under `/powerup:supply-chain` before the first dependency was added, as the plan's
blocking gate requires. The reference implementation's table (2026-08-06, npm-shaped) was
**not** translated — this vet was done fresh against the live registry.

Method: `npm view <pkg> time --json` for per-version publish timestamps (not `time.modified`,
which reports document changes rather than the version's own publish), `npm view <pkg> scripts`
for install hooks, and the npm downloads API. Reads only — nothing was installed during the vet.

## Pins

| Package | Pin | Age at vet | Maintainers | Install script | Downloads/wk | Risk |
|---|---|---|---|---|---|---|
| `@playwright/test` | **1.63.0** | 118 h (~5 d) | pavelfeldman, yurys, dgozman-ms, microsoft-oss-releases, microsoft1es | none declared | 54.4 M | **LOW** |
| `vitest` | **5.0.0** | 152 h (~6 d) | ariperkkio, antfu, hiogawa, oreanno, yyx990803 | none (build scripts only) | 92.7 M | **LOW** |
| `typescript` | **7.0.2** | 1 517 h (~63 d) | microsoft1es, typescript-bot, weswigham, andrewbranch, jakebailey, microsoft-oss-releases, typescript-deploys | none declared | 244.7 M | **LOW** |
| `@types/node` | **22.20.1** | 1 526 h (~64 d) | types (DefinitelyTyped bot) | none declared | 384.0 M | **LOW** — type-only, no runtime code |

All four are on their expected publishers, all are far past the 24-hour cooldown, and none
declares a `preinstall`/`postinstall` hook.

## Findings

### 1. `@types/node@22.20.2` was REJECTED — published 2.6 hours before the vet

The latest 22.x was **2.6 hours old**, which is the single strongest red flag in the vetting
procedure. It is almost certainly a benign DefinitelyTyped bulk republish (26.5.1, 25.9.6,
24.13.4 and 22.20.2 all landed within 80 seconds of each other), but "almost certainly benign"
is exactly the reasoning the cooldown exists to override — the TanStack and SAP CAP malicious
versions were each pulled within ~4 hours of publication.

Pinned **22.20.1** (64 days old) instead. `minimumReleaseAge=1440` would have refused 22.20.2
regardless; the pin makes the decision explicit rather than relying on the guard.

### 2. `tsx` was DROPPED, not pinned — Node 22 makes it unnecessary

Verified on this host (Node **v22.23.2**; type stripping is unflagged from 22.18.0, so `engines` says `>=22.18`): a `.ts` entry point with a `.ts` import, a typed
interface and an annotated const runs with **no flags and no loader**.

```
$ node main.ts
hello node 22 native type stripping
```

Dropping it removes, in order of value:

- **The only single-maintainer package in the tree.** `tsx` is published solely by
  `hirokiosame`. Reputable and long-established, but a one-maintainer account is the exact
  surface every recent worm wave compromises.
- **The only install script in scope.** `tsx` depends on `esbuild ~0.28.0`, which declares
  `"postinstall": "node install.js"`. No direct dependency now declares an install hook at all.
- One dependency's worth of transitive surface, for no capability we use.

`esbuild` may still arrive transitively through `vitest`/`vite`. Check with `pnpm why esbuild`
after install; if present, allowlist it explicitly in `pnpm-workspace.yaml` under `allowBuilds`
rather than opening scripts globally.

> Not claimed as a win: this does **not** eliminate the `page.evaluate` `__name` trap the
> reference implementation documents. That hazard comes from esbuild's `keepNames` rewriting
> code shipped into the browser, and journey code reaches the browser through *Playwright's*
> transform, not through `tsx`. The trap must still be understood and documented.

### 3. `.npmrc` was rewritten for pnpm — the plan had carried an npm-shaped file

The plan inherited the reference implementation's npm hardening verbatim, including
`package-lock=true`, which is meaningless under pnpm. pnpm 11+ (this host runs **11.15.1**)
offers strictly stronger controls that npm has no equivalent for:

| Setting | Why |
|---|---|
| `minimumReleaseAge=1440` | 24-hour quarantine on newly published packages. npm has nothing like it. This alone would have blocked both the TanStack and SAP CAP attacks. |
| `blockExoticSubdeps=true` | Refuses git/tarball transitive dependencies — the "hidden payload in a subdep" vector. |
| `save-exact=true` | `pnpm add` writes an exact version, never a caret range. |

`ignore-scripts=true` is deliberately **not** set: under pnpm, build scripts are already
deny-by-default and permitted only through the `allowBuilds` allowlist, which is the finer
instrument.

### 4. `vitest@5.0.0` is a major release only six days old

Past the cooldown, so not a supply-chain concern — but it is a **major** version with little
field exposure, and the reference implementation was built on the 4.x line. Taken deliberately:
this is a greenfield project with no migration cost, and pinning 4.1.11 would start the project
one major behind. If the 5.x config or API shape causes friction, 4.1.11 (534 h, very
well-aged) is the fallback.

## Posture

Installs run on a daily-driver machine holding credentials, which the skill flags as the
scenario worth avoiding. Accepted here on the basis that all four pins are well past the
cooldown, none declares an install hook, `blockExoticSubdeps` is on, and pnpm will not execute
a build script that is not explicitly allowlisted. Revisit if a future dependency needs
`allowBuilds`.

## Re-vet triggers

Any dependency added or bumped; any lockfile diff that cannot be explained from the
`package.json` diff; any CI failure that mentions a package version nobody chose.

## 2026-09-16: R59/R93, promoting `@playwright/test` to `dependencies` — WITHDRAWN (R100)

**The concern (R59).** `package.json` has no `dependencies` field, but the CLI value-imports
`chromium` from `@playwright/test` when it loads. An npm-installed `wpj` would therefore fail
with `ERR_MODULE_NOT_FOUND` before it could even print usage.

**The gate (R93, run by the controller; reads only, nothing installed).**

| Check | Result |
|---|---|
| The chain `@playwright/test` → `playwright` → `playwright-core`, all 1.63.0 | No lifecycle scripts. No `optionalDependencies`. |
| Lockfile | No `requiresBuild`, tarball or git resolutions. `allowBuilds: []`. |
| Version | 1.63.0 is unchanged; it was vetted above (LOW). |
| Does the install fetch a browser? | **No.** The browser is still fetched by an explicit command (`pnpm browser`). |
| Backdoor paths (`.vscode/tasks.json`, `.claude/settings.json`, `setup.mjs`) | None in the repo. |

**Outcome: the move is WITHDRAWN.** Publishing to npm is a spec non-goal
(`docs/superpowers/specs/2026-09-06-wp-journeys.md`: "distribution as an installable package is a
later decision"). v1 runs from a clone, where `devDependencies` are installed. So
`@playwright/test` stays in `devDependencies`, and neither the lockfile nor the store was
touched. `package.json` is now `"private": true`, so nothing can be published by accident.

**What was kept, because it helps people running from a clone.** A launch that fails with
Playwright's `Executable doesn't exist` banner becomes one line naming
`npx playwright install chromium` (`src/runner/browser.ts`). `wpj run` also launches the browser
before it touches the site.

**What the later npm decision must settle:**

1. **Runtime dependency placement.** `@playwright/test` would need to be in `dependencies` (the
   gate above covers it), or the CLI would need to stop importing it at load time.
2. **A build step.** Node refuses to strip types from `.ts` files under `node_modules`, and the
   package ships `bin/wpj.js` → `src/runner/cli.ts`. Reproduced on v22.23.2:

   ```
   Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently unsupported for files under node_modules, for "file:///…/node_modules/pkg/src/a.ts"
   ```

3. **An `exports`/`types` entry.** Without one, an escape-hatch module cannot write
   `import type { Journey } from 'wp-journeys'`.

`files` already includes `skills`, so a future package would carry what `wpj skills install`
links.
