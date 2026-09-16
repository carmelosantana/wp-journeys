/** An escape-hatch module whose result carries `notes` that are not strings. */
import type { Journey } from '../../../src/journeys/index.ts';

const badNotes = {
  name: 'bad-notes', actor: 'editor', surface: 'admin',
  run: async () => ({ name: 'bad-notes', actor: 'editor', surface: 'admin', entitiesCreated: 0, findings: [], notes: 'one line' }),
} as unknown as Journey;

export default badNotes;
