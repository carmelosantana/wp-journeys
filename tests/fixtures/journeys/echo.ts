/**
 * A manifest escape-hatch module: a TypeScript file default-exporting a Journey, loaded by
 * the interpreter at run time through `module: "tests/fixtures/journeys/echo.ts"`.
 *
 * It never touches the browser; its result carries a marker finding so a test can prove that
 * THIS module's run is what the interpreted journey delegated to. Its own identity fields
 * deliberately disagree with any manifest entry that names it, so a test can prove the
 * MANIFEST's identity is what the summary sees.
 */
import type { Journey } from '../../../src/journeys/index.ts';

const echo: Journey = {
  name: 'echo',
  actor: 'administrator',
  surface: 'both',
  run: async () => ({
    name: 'echo', actor: 'administrator', surface: 'both', entitiesCreated: 3,
    findings: [{ kind: 'assertion', text: 'echo module ran' }],
  }),
};

export default echo;
