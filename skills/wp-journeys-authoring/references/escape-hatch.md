# The TypeScript escape hatch

Use a `module` only when screens, settings and shortcodes cannot express the journey. For
example: a multi-step flow, a custom post type, or an AJAX action. The module path is
relative to the manifest directory, and a path that resolves outside that directory is refused.

```json
{ "name": "acme-creates-a-widget", "actor": "editor", "surface": "both", "module": "journeys/create-widget.ts" }
```

The module default-exports a `Journey`. The runner calls `run(browser, cfg, agent)` directly.
**It does not wrap your module in a sentinel or a login, so `runAsActor` is not optional.**

```ts
// journeys/create-widget.ts. Node 22 runs this natively; type-only imports are erased.
import type { Journey } from '<wp-journeys>/src/journeys/index.ts';
import { CONTROL_SCREEN, runAsActor } from '<wp-journeys>/src/journeys/support.ts';

const journey: Journey = {
  // The runner re-labels the result with the MANIFEST's name, actor and surface.
  name: 'acme-creates-a-widget',
  actor: 'editor',
  surface: 'both',
  run: (browser, cfg, agent) =>
    // runAsActor: a fresh page with the sentinel armed, a login proven by positive evidence, a
    // thrown error recorded as this journey's failure, and the sentinel drained at the end.
    runAsActor(browser, cfg, agent, 'acme-creates-a-widget', 'editor', 'both', async (page, sentinel, note) => {
      // The control visit. Without it, a session that was silently never established would
      // pass every denial below through the login redirect.
      sentinel.expect({ denyExpected: false });
      await sentinel.visit(page, CONTROL_SCREEN);

      // Always sentinel.visit, never page.goto: goto asserts nothing about the status, and a 502
      // error page reads as content. expect() is one-shot, so declare it before EVERY visit.
      sentinel.expect({ denyExpected: false });
      await sentinel.visit(page, '/wp-admin/post-new.php?post_type=acme_widget');
      await page.fill('#title', 'wpj widget');
      await page.click('#publish');          // input is never retried: a retry double-submits
      await page.waitForLoadState('networkidle');

      // Read the effect back where a visitor sees it. A 2xx after a write proves nothing.
      sentinel.expect({ denyExpected: false });
      await sentinel.visit(page, '/?post_type=acme_widget');
      if (!(await page.locator('body').innerText()).includes('wpj widget')) {
        throw new Error('the widget was saved in wp-admin but never appeared on the frontend');
      }
      note('created one acme_widget post; it is not cleaned up');
      return 1;                               // entitiesCreated
    }),
};

export default journey;
```

## Rules

| Rule | Why |
|---|---|
| A skip is `{ skipped: true, skipReason }`, always both fields. | A `skipReason` without `skipped: true` is refused, because it would otherwise render as a pass. |
| Never return an empty `findings` array for a path you did not exercise. | Return a skip instead. |
| Throw to fail. | `runAsActor` records the message as an `assertion` finding. |
| Only a 401, a 403 or the login redirect satisfies `denyExpected: true`. | A 404 or 5xx on a denial is a finding. So is an unexpected 403 on `denyExpected: false`. |
| A result that is not a `JourneyResult` is refused, and the refusal names the module. | |

## Importing the SDK (an open gap)

wp-journeys has no `exports` or `types` entry yet, so there is no `import … from 'wp-journeys'`.
Replace `<wp-journeys>` above with a path to a **checkout** of wp-journeys. Node 22 also refuses
to strip types from any `.ts` file under `node_modules`, so the value import (`runAsActor`)
cannot come from an npm-installed copy either. `import type` lines are erased before they
load, so they cost nothing at run time.
