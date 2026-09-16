/**
 * The skills describe the runner AS IT IS. These checks fail when the code moves and the prose
 * does not: a skill teaching a tool, a variable or a manifest key that no longer exists is a
 * false green of its own.
 */
import { spawnSync } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ALL_ACTORS } from '../src/actors/roles.ts';
import { skillsRoot } from '../src/commands/skills.ts';
import { TOOLS } from '../src/mcp/tools.ts';
import { SPAWN_TIMEOUT_MS } from './helpers/timeouts.ts';
import {
  DEPRECATED_KEYS, GATE_KEYS, JOURNEY_KEYS, MANIFEST_KEYS, OPTIONAL_SETTING_KEYS, SCREEN_KEYS, SETTING_KEYS, parseManifest,
} from '../src/manifest/schema.ts';
import { CLI_ENV, HOME_VAR } from '../src/runner/cli.ts';
import { SIGNAL_KINDS } from '../src/sentinel/phplog.ts';

const RUNNING = join(skillsRoot(), 'wp-journeys-running');
const AUTHORING = join(skillsRoot(), 'wp-journeys-authoring');

async function read(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

/**
 * The inline code spans of a markdown text, read left to right the way a renderer pairs the
 * backticks, so the text BETWEEN two spans is never mistaken for one.
 */
function codeSpans(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
}

/**
 * Whether `key` is written as a manifest key: a span that IS the key, a dotted path with the key
 * as one segment (`gate.screen`, `settings[].submit`), or a `{a, b?}` shape listing it. A word
 * inside some other span (`/path`) does not count.
 */
function documentsKey(text: string, key: string): boolean {
  return codeSpans(text).some((span) => {
    const members = /^\{(.*)\}$/.exec(span);
    if (members) return members[1]!.split(',').map((m) => m.trim().replace(/\?$/, '')).includes(key);
    return span.split('.').map((segment) => segment.replace(/\[\]$/, '').replace(/\?$/, '')).includes(key);
  });
}

/** Every `.md` file of a skill, SKILL.md first. */
async function markdownOf(skill: string): Promise<string[]> {
  const files = [join(skill, 'SKILL.md')];
  for (const entry of await readdir(join(skill, 'references')).catch(() => [] as string[])) {
    if (entry.endsWith('.md')) files.push(join(skill, 'references', entry));
  }
  return files;
}

describe.each([
  ['wp-journeys-running', RUNNING],
  ['wp-journeys-authoring', AUTHORING],
])('the %s skill', (name, dir) => {
  it('carries frontmatter naming itself, with a "Use when" description inside the length limit', async () => {
    const text = await read(join(dir, 'SKILL.md'));
    const front = text.match(/^---\n([\s\S]*?)\n---\n/);
    const [block = '', body = ''] = front ?? [];
    expect(body).toMatch(new RegExp(`^name: ${name}$`, 'm'));
    const description = body.match(/^description: (.+)$/m)?.[1] ?? '';
    expect(description).toMatch(/^Use when /);
    expect(block.length).toBeLessThanOrEqual(1024);
  });

  it('links only to files that exist', async () => {
    for (const file of await markdownOf(dir)) {
      const links = [...(await read(file)).matchAll(/\]\(([^)#]+)\)/g)].map((m) => m[1]!);
      for (const link of links.filter((l) => !/^[a-z]+:/.test(l))) {
        await expect(access(join(dirname(file), link)), `${file} -> ${link}`).resolves.toBeUndefined();
      }
    }
  });

  it('never teaches the retired WPJ_PLUGIN_DIR as something to set', async () => {
    for (const file of await markdownOf(dir)) {
      for (const line of (await read(file)).split('\n').filter((l) => l.includes('WPJ_PLUGIN_DIR'))) {
        expect(line, file).toMatch(/refused/);
      }
    }
  });
});

describe('the running skill', () => {
  it('names every MCP tool the server has', async () => {
    const text = await read(join(RUNNING, 'SKILL.md'));
    for (const tool of Object.keys(TOOLS)) expect(text).toContain(`\`${tool}\``);
    expect(text).toContain(`${['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'][Object.keys(TOOLS).length]} tools`);
  });

  it('names every variable the runner reads', async () => {
    const text = await read(join(RUNNING, 'SKILL.md'));
    // From the modules that read them, so a renamed variable fails here (R103). HOME belongs to
    // `skills install`, which the README documents; the skill's table is for `wpj run`.
    const variables = CLI_ENV.filter((name) => name !== HOME_VAR);
    expect(variables.length).toBe(4);
    for (const variable of variables) expect(codeSpans(text)).toContain(variable);
  });

  it('says a skip is not a pass, and that run_journey toggles the plugin and refuses lifecycle', async () => {
    const text = await read(join(RUNNING, 'SKILL.md'));
    expect(text).toMatch(/skip.*never an ok/i);
    expect(text).toMatch(/run_journey.*deactivates and then reactivates/s);
    expect(text).toMatch(/refuses `lifecycle`/);
    expect(text).toMatch(/wph mount.*activates/s);
  });

  it('configures MCP with node and the clone path, since `wpj` is not on PATH (R103)', async () => {
    const text = await read(join(RUNNING, 'references', 'mcp.md'));
    expect(text).not.toMatch(/"command":\s*"wpj"/);
    expect(text).toContain('"command": "node", "args": ["/path/to/wp-journeys/bin/wpj.js", "mcp"]');
  });

  it('explains every finding kind the sentinel can produce', async () => {
    const text = await read(join(RUNNING, 'references', 'run-output.md'));
    const table = text.split('## Chasing a finding')[1]?.split('\n## ')[0] ?? '';
    const rows = [...table.matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1]!);
    expect(new Set(rows)).toEqual(new Set(SIGNAL_KINDS));
  });

  it('fetches the browser through the clone\'s pinned Playwright, never npx', async () => {
    for (const file of await markdownOf(RUNNING)) {
      const text = await read(file);
      for (const line of text.split('\n').filter((l) => /npx playwright/.test(l))) {
        expect(line, file).toMatch(/never `npx playwright`/);
      }
    }
    expect(await read(join(RUNNING, 'SKILL.md'))).toContain('pnpm --dir /path/to/wp-journeys browser');
  });

  it('names all six actors', async () => {
    const text = await read(join(RUNNING, 'references', 'run-output.md'));
    for (const actor of ALL_ACTORS) expect(text).toContain(`\`${actor}\``);
  });
});

describe('the dev-only warning in the running skill (R103)', () => {
  /** The same three facts, wherever an agent is told how to open the guard. */
  function expectWarning(text: string, where: string): void {
    expect(text, where).toMatch(/DEV-ONLY/);
    expect(text, where).toMatch(/never install the mu-plugin on a production or publicly reachable site/i);
    expect(text, where).toMatch(/never set `WP_ENVIRONMENT_TYPE`, `WP_DEBUG` or `WPJ_AGENT` on a site that is not already a disposable local one/i);
    expect(text, where).toMatch(/render doors are signed and expire/i);
    expect(text, where).not.toMatch(/no credential/i);
  }

  it('warns in SKILL.md, at the step that sends the reader to install it', async () => {
    const text = await read(join(RUNNING, 'SKILL.md'));
    const step = text.split('## Before the first run')[1]?.split('\n2. ')[0] ?? '';
    expectWarning(step, 'SKILL.md step 1');
  });

  it('warns at the top of setup.md, before any command that opens the guard', async () => {
    const text = await read(join(RUNNING, 'references', 'setup.md'));
    // Before the first section, and so before any `config set` or define() the page gives.
    const top = text.split('\n## ')[0] ?? '';
    expect(top).not.toMatch(/config set|define\(/);
    expectWarning(top, 'setup.md top');
    expect(text).not.toMatch(/any other local WordPress/i);
    expect(text).toMatch(/## On another disposable local WordPress/);
  });
});

describe('the authoring skill', () => {
  it('documents every key the manifest schema accepts', async () => {
    const text = await read(join(AUTHORING, 'SKILL.md'));
    const keys = [...MANIFEST_KEYS, ...JOURNEY_KEYS, ...SCREEN_KEYS, ...SETTING_KEYS, ...OPTIONAL_SETTING_KEYS];
    for (const key of keys) expect(documentsKey(text, key), key).toBe(true);
    // The nested blocks, by their full path.
    for (const key of GATE_KEYS) expect(codeSpans(text), `gate.${key}`).toContain(`gate.${key}`);
    for (const key of DEPRECATED_KEYS) expect(codeSpans(text), `deprecated.${key}`).toContain(`deprecated.${key}`);
  });

  it('does not count a key that appears only inside some other span', () => {
    expect(documentsKey('a `/path` and `wph mount`', 'path')).toBe(false);
    expect(documentsKey('`a` path `b`', 'path')).toBe(false);
    expect(documentsKey('`settings[].submit` and `{url, allow}`', 'submit')).toBe(true);
    expect(documentsKey('`{url, allow, deny}`', 'allow')).toBe(true);
  });

  it('names all six actors', async () => {
    const text = await read(join(AUTHORING, 'SKILL.md'));
    for (const actor of ALL_ACTORS) expect(text).toContain(`\`${actor}\``);
  });

  it('ships a copy-ready manifest the schema accepts, using every optional block', async () => {
    const file = join(AUTHORING, 'assets', 'wp-journeys.json');
    const manifest = parseManifest(JSON.parse(await read(file)), file);
    expect(manifest.gate).toBeDefined();
    expect(manifest.deprecated?.shortcodes.length).toBeGreaterThan(0);
    expect(manifest.journeys.some((j) => j.settings?.some((s) => s.submit !== undefined))).toBe(true);
    expect(manifest.journeys.some((j) => j.screens?.some((s) => s.deny.includes(j.actor)))).toBe(true);
    expect(manifest.journeys.some((j) => j.shortcodes !== undefined)).toBe(true);
  });

  it('carries the false-greens reference with the brief\'s six cases and first contact\'s three', async () => {
    const text = await read(join(AUTHORING, 'references', 'false-greens.md'));
    for (const phrase of [
      /watches only the HTTP status/,
      /always skips, shown as `ok`/,
      /manifest silently ignored/,
      /Trusting a 2xx on a write/,
      /lost `debug\.log` signal reported as an empty delta/,
      /Discovery without a deactivated baseline/,
      /refused login token read as a session \(R54\)/,
      /orphan check blind after an activating mount \(R75\)/,
      /cron handler trusted without checking where it came from \(R79\)/,
      /for the right reason/,
    ]) {
      expect(text).toMatch(phrase);
    }
  });
});

describe('README.md (R102)', { timeout: SPAWN_TIMEOUT_MS }, () => {
  const ROOT = join(skillsRoot(), '..');

  it('lists exactly the environment variables usage() names', async () => {
    const result = spawnSync(process.execPath, [join(ROOT, 'bin', 'wpj.js')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    const section = result.stderr.split('environment:\n')[1]?.split('\n\n')[0] ?? '';
    const fromUsage = [...section.matchAll(/^ {2}([A-Z_]+) /gm)].map((m) => m[1]!);
    expect(fromUsage.length).toBeGreaterThan(3);

    const readme = await read(join(ROOT, 'README.md'));
    const table = readme.split('## Environment')[1]?.split('\n## ')[0] ?? '';
    const fromReadme = [...table.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]!);
    expect(fromReadme).toEqual(fromUsage);
  });

  it('names every MCP tool and every command usage() offers', async () => {
    const readme = await read(join(ROOT, 'README.md'));
    for (const tool of Object.keys(TOOLS)) expect(readme).toContain(`\`${tool}\``);
    for (const command of ['wpj run --plugin', 'wpj mcp', 'wpj skills install']) expect(readme).toContain(command);
    // main() exits 2 for bad arguments AND for an unset WPJ_WP (R103).
    expect(readme).toMatch(/Exit 2 means bad arguments, or `WPJ_WP` is unset/);
  });

  it('warns that the companion mu-plugin is dev-only, and ships the license it names', async () => {
    const readme = await read(join(ROOT, 'README.md'));
    expect(readme).toMatch(/never install it on a production site/i);
    expect(readme).toMatch(/render doors\s+(?:>\s*)?are signed and expire/i);
    expect(readme).not.toMatch(/have no credential/i);
    const license = await read(join(ROOT, 'LICENSE'));
    expect(license).toMatch(/^MIT License\n\nCopyright \(c\) 2026 Carmelo Santana\n/);
    expect(JSON.parse(await read(join(ROOT, 'package.json'))).license).toBe('MIT');
  });
});

describe('the Node floor (R103)', () => {
  const ROOT = join(skillsRoot(), '..');

  it('is 22.18, where type stripping runs unflagged, in package.json and everywhere the docs state it', async () => {
    expect(JSON.parse(await read(join(ROOT, 'package.json'))).engines).toEqual({ node: '>=22.18' });
    const files = [join(ROOT, 'README.md'), ...await markdownOf(RUNNING), ...await markdownOf(AUTHORING)];
    let stated = 0;
    for (const file of files) {
      const text = await read(file);
      // Any "Node 22" must be the full floor.
      for (const match of text.matchAll(/Node(?:\.js)? 22(\.\d+)?/g)) {
        expect(match[1], `${file}: ${match[0]}`).toBe('.18');
        stated += 1;
      }
    }
    expect(stated).toBeGreaterThanOrEqual(3);
  });
});

describe('the variable names (R103)', () => {
  it('are read only through their named constants, so the checks above see a rename', async () => {
    const ROOT = join(skillsRoot(), '..');
    const files = ['bin/wpj.js', 'src/config.ts', 'src/runner/cli.ts', 'src/mcp/server.ts', 'src/commands/skills.ts'];
    for (const file of files) {
      const text = await read(join(ROOT, file));
      // WPJ_PLUGIN_DIR is the retired name, read only to refuse it.
      const literal = [...text.matchAll(/env\s*(?:\.|\[\s*['"`])(WPJ_\w+|HOME)\b/g)].map((m) => m[1]).filter((n) => n !== 'WPJ_PLUGIN_DIR');
      expect(literal, file).toEqual([]);
    }
  });
});
