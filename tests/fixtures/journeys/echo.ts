/**
 * A manifest escape-hatch module: a TypeScript file default-exporting a Journey, loaded by
 * the interpreter at run time through `module: "tests/fixtures/journeys/echo.ts"`.
 *
 * It never touches the browser; its result carries a marker finding so a test can prove that
 * THIS module's run is what the interpreted journey delegated to.
 */
import type { Journey } from '../../../src/journeys/index.ts';

const echo: Journey = {
  name: 'echo',
  actor: 'editor',
  surface: 'admin',
  run: async () => ({
    name: 'echo', actor: 'editor', surface: 'admin', entitiesCreated: 0,
    findings: [{ kind: 'assertion', text: 'echo module ran' }],
  }),
};

export default echo;
