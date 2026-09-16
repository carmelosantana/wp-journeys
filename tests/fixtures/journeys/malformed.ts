/**
 * An escape-hatch module whose default export LOOKS like a Journey — it has a `run` — but
 * whose result is not a JourneyResult. The interpreter must refuse it by name at run(),
 * rather than let it reach `outcomeOf` and abort the whole summary.
 */
export default {
  name: 'malformed',
  actor: 'editor',
  surface: 'admin',
  run: async () => 'nope',
};
