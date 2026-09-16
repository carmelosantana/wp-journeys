import { lstat, mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { installSkills, shippedSkills, skillsRoot, skillTarget } from '../src/commands/skills.ts';

/** Collects what the installer says, so a test run prints nothing and can assert on the words. */
function capture(): { out: string[]; err: string[]; io: { out: (s: string) => void; err: (s: string) => void } } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s) } };
}

/** A skills root holding two real skills and one directory that is not a skill. */
async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wpj-skills-'));
  for (const name of ['alpha', 'beta']) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, 'SKILL.md'), `# ${name}`);
  }
  await mkdir(join(root, 'notaskill'), { recursive: true });
  return root;
}

describe('shippedSkills', () => {
  it('lists only directories that actually carry a SKILL.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wpj-skills-'));
    await mkdir(join(root, 'real'), { recursive: true });
    await writeFile(join(root, 'real', 'SKILL.md'), '# real');
    await mkdir(join(root, 'notaskill'), { recursive: true });

    expect(await shippedSkills(root)).toEqual(['real']);
  });

  it('returns nothing rather than throwing when the root does not exist', async () => {
    expect(await shippedSkills('/no/such/path')).toEqual([]);
  });

  it('finds exactly the two skills this checkout ships', async () => {
    expect(await shippedSkills(skillsRoot())).toEqual(['wp-journeys-authoring', 'wp-journeys-running']);
  });
});

describe('skillTarget', () => {
  it('points at ~/.claude/skills/<name>', () => {
    expect(skillTarget('/home/x', 'wp-journeys-running')).toBe('/home/x/.claude/skills/wp-journeys-running');
  });
});

describe('installSkills', () => {
  it('symlinks back to the checkout so it stays the single source of truth', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wpj-home-'));
    const { io } = capture();

    expect(await installSkills(home, { io })).toBe(0);

    const link = await readlink(skillTarget(home, 'wp-journeys-running'));
    expect(link).toBe(join(skillsRoot(), 'wp-journeys-running'));
    expect(await readlink(skillTarget(home, 'wp-journeys-authoring'))).toBe(join(skillsRoot(), 'wp-journeys-authoring'));
    // Through the link, the real file.
    expect(await readFile(join(skillTarget(home, 'wp-journeys-running'), 'SKILL.md'), 'utf8')).toMatch(/^---\nname: wp-journeys-running\n/);
  });

  it('is idempotent — running twice leaves the same link', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wpj-home-'));
    const { io } = capture();

    expect(await installSkills(home, { io })).toBe(0);
    expect(await installSkills(home, { io })).toBe(0);

    expect(await readlink(skillTarget(home, 'wp-journeys-running'))).toBe(join(skillsRoot(), 'wp-journeys-running'));
  });

  it('links only real skills, and says what it linked', async () => {
    const root = await fixtureRoot();
    const home = await mkdtemp(join(tmpdir(), 'wpj-home-'));
    const { out, err, io } = capture();

    expect(await installSkills(home, { root, io })).toBe(0);

    expect(await readlink(skillTarget(home, 'alpha'))).toBe(join(root, 'alpha'));
    await expect(lstat(skillTarget(home, 'notaskill'))).rejects.toThrow(/ENOENT/);
    expect(out.join('')).toContain(`linked ${skillTarget(home, 'alpha')} -> ${join(root, 'alpha')}`);
    expect(err).toEqual([]);
  });

  it('replaces a stale symlink of its own name — that is a re-run converging, not a user file', async () => {
    const root = await fixtureRoot();
    const home = await mkdtemp(join(tmpdir(), 'wpj-home-'));
    await mkdir(join(home, '.claude', 'skills'), { recursive: true });
    await symlink('/an/old/checkout/alpha', skillTarget(home, 'alpha'), 'dir');
    const { io } = capture();

    expect(await installSkills(home, { root, io })).toBe(0);
    expect(await readlink(skillTarget(home, 'alpha'))).toBe(join(root, 'alpha'));
  });

  it('refuses a REAL directory at the target, deletes nothing, and fails naming the path (R98)', async () => {
    const root = await fixtureRoot();
    const home = await mkdtemp(join(tmpdir(), 'wpj-home-'));
    // A user's own hand-written skill that happens to share the name.
    const mine = skillTarget(home, 'beta');
    await mkdir(join(mine, 'references'), { recursive: true });
    await writeFile(join(mine, 'SKILL.md'), 'my own skill');
    await writeFile(join(mine, 'references', 'notes.md'), 'my notes');
    const { out, err, io } = capture();

    const code = await installSkills(home, { root, io });

    expect(code).not.toBe(0);
    expect(err.join('')).toContain(mine);
    // Everything the user had survives, byte for byte.
    expect((await lstat(mine)).isDirectory()).toBe(true);
    expect(await readFile(join(mine, 'SKILL.md'), 'utf8')).toBe('my own skill');
    expect(await readFile(join(mine, 'references', 'notes.md'), 'utf8')).toBe('my notes');
    // Refused BEFORE linking anything: a half-installed pair is not what was asked for.
    await expect(lstat(skillTarget(home, 'alpha'))).rejects.toThrow(/ENOENT/);
    expect(out).toEqual([]);
  });

  it('refuses a plain FILE at the target the same way (R98)', async () => {
    const root = await fixtureRoot();
    const home = await mkdtemp(join(tmpdir(), 'wpj-home-'));
    await mkdir(join(home, '.claude', 'skills'), { recursive: true });
    const file = skillTarget(home, 'alpha');
    await writeFile(file, 'not a link');
    const { err, io } = capture();

    expect(await installSkills(home, { root, io })).not.toBe(0);
    expect(err.join('')).toContain(file);
    expect(await readFile(file, 'utf8')).toBe('not a link');
  });

  it('fails, rather than reporting success, when there is nothing to link', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wpj-home-'));
    const { err, io } = capture();

    expect(await installSkills(home, { root: '/no/such/path', io })).not.toBe(0);
    expect(err.join('')).toContain('/no/such/path');
  });
});
