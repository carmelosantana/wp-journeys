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
import { JOURNEY_KEYS, MANIFEST_KEYS, OPTIONAL_SETTING_KEYS, SCREEN_KEYS, SETTING_KEYS, parseManifest } from '../src/manifest/schema.ts';

const RUNNING = join(skillsRoot(), 'wp-journeys-running');
const AUTHORING = join(skillsRoot(), 'wp-journeys-authoring');

async function read(path: string): Promise<string> {
  return readFile(path, 'utf8');
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
    for (const variable of ['WPJ_BASE_URL', 'WPJ_AGENT_SECRET', 'WPJ_WP', 'WPJ_MANIFEST_DIR']) {
      expect(text).toContain(`\`${variable}\``);
    }
  });

  it('says a skip is not a pass, and that run_journey toggles the plugin and refuses lifecycle', async () => {
    const text = await read(join(RUNNING, 'SKILL.md'));
    expect(text).toMatch(/skip.*never an ok/i);
    expect(text).toMatch(/run_journey.*deactivates and then reactivates/s);
    expect(text).toMatch(/refuses `lifecycle`/);
    expect(text).toMatch(/wph mount.*activates/s);
  });

  it('names all six actors', async () => {
    const text = await read(join(RUNNING, 'references', 'run-output.md'));
    for (const actor of ALL_ACTORS) expect(text).toContain(`\`${actor}\``);
  });
});

describe('the authoring skill', () => {
  it('documents every key the manifest schema accepts', async () => {
    const text = await read(join(AUTHORING, 'SKILL.md'));
    const keys = [...MANIFEST_KEYS, ...JOURNEY_KEYS, ...SCREEN_KEYS, ...SETTING_KEYS, ...OPTIONAL_SETTING_KEYS, 'gate.screen', 'deprecated.shortcodes'];
    for (const key of keys.filter((k) => k !== 'gate' && k !== 'deprecated')) {
      // Written as code: after a backtick, with no backtick in between.
      expect(text, key).toMatch(new RegExp(`\`[^\`]*(?<!\\w)${key.replace(/[$.]/g, '\\$&')}(?!\\w)`));
    }
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
  });

  it('warns that the companion mu-plugin is dev-only, and ships the license it names', async () => {
    const readme = await read(join(ROOT, 'README.md'));
    expect(readme).toMatch(/never install it on a production site/i);
    const license = await read(join(ROOT, 'LICENSE'));
    expect(license).toMatch(/^MIT License\n\nCopyright \(c\) 2026 Carmelo Santana\n/);
    expect(JSON.parse(await read(join(ROOT, 'package.json'))).license).toBe('MIT');
  });
});
