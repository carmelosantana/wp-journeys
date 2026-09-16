/**
 * An escape-hatch module whose run() throws, as third-party code does. The interpreter must
 * rethrow with the journey name and the module path, keeping this error as the `cause`.
 */
import type { Journey } from '../../../src/journeys/index.ts';

const throws: Journey = {
  name: 'throws',
  actor: 'editor',
  surface: 'admin',
  run: async () => {
    throw new Error('module exploded');
  },
};

export default throws;
