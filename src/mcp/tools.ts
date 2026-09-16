/**
 * The MCP tool table — a declarative surface over primitives that already exist.
 *
 * If any judgement appears in this file, it is in the wrong place: the classifiers, the
 * matrix, the interpreter and the summary own every decision, and the MCP server only
 * routes to them.
 */
import { ALL_ACTORS } from '../actors/roles.ts';

export interface ToolDefinition {
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: readonly string[] }>;
    required: string[];
  };
}

export const TOOLS: Record<string, ToolDefinition> = {
  status: {
    description: 'Report the target WordPress version, PHP version, and whether the debug log signal is available '
      + '(and, when it is not, why). Also reports a broken runner configuration.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  discover_surface: {
    description: 'Return the admin screens, blocks, shortcodes, REST routes and capabilities the site currently registers.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  login_as: {
    description: 'Open an isolated browser context as one of the six actors, with the sentinel armed. Anonymous does not log in. '
      + 'Only one session is held: a previous session is drained first, and its findings are returned here. '
      + 'Session findings are not baseline-subtracted: noise the site emits on every request is reported too. '
      + 'A result that carries findings has isError set, even when the login itself succeeded.',
    inputSchema: {
      type: 'object',
      properties: { actor: { type: 'string', description: 'Which actor to become.', enum: ALL_ACTORS } },
      required: ['actor'],
    },
  },
  navigate: {
    description: 'Navigate the current actor context to a path on the target site. Returns the HTTP status, the final URL '
      + 'and this visit\'s verdict; empty verdict findings mean the document was what was expected.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'A site-relative path starting with exactly one "/", e.g. /wp-admin/.' },
        expect_denied: {
          type: 'boolean',
          description: 'Whether this actor must be DENIED this path (403/401 or the login redirect). Applies to this visit only. Default false.',
        },
      },
      required: ['path'],
    },
  },
  read_page: {
    description: 'Return the current page as readable text, for inspecting what the actor can actually see.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  drain_sentinel: {
    description: 'Collect every finding observed so far, including the PHP debug.log delta. Empty means clean. '
      + 'Findings are not baseline-subtracted: noise the site emits on every request is reported too.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  run_journey: {
    description: 'Run one registered journey by name and return its result, including its pass/fail/skip outcome. '
      + 'This captures the run baseline exactly as `wpj run` does: it deactivates and then reactivates the plugin under '
      + 'test, so the plugin is left active. lifecycle journeys uninstall the plugin and are refused — use `wpj run`. '
      + 'A held session is drained and closed first, and its findings are returned with the result '
      + '(isError is set when there are any, whatever the outcome).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The journey name, as it appears in the run summary.' },
        plugin: { type: 'string', description: 'The slug of the plugin under test.' },
      },
      required: ['name', 'plugin'],
    },
  },
};

/** The listing the MCP handshake returns. Stable ordering so the output is diffable. */
export function describeTools(): Array<{ name: string } & ToolDefinition> {
  return Object.keys(TOOLS)
    .sort()
    .map((name) => ({ name, ...TOOLS[name]! }));
}
