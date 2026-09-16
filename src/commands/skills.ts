/**
 * `wpj skills install`: link this checkout's skills into `~/.claude/skills`.
 *
 * Symlinks, never copies: the checkout stays the single source of truth, so editing a SKILL.md
 * takes effect for every agent immediately, and there is no second copy to drift.
 *
 * R98: the installer REPLACES ONLY A SYMLINK. A symlink at the target is this command's own
 * earlier work (or a stale link to an old checkout), and replacing it is how a re-run
 * converges. Anything else at the target, a directory or a file, belongs to the user: a
 * hand-written skill that happens to share the name. It is refused loudly, by path, with a
 * non-zero exit, and nothing is deleted. Every target is checked BEFORE anything is linked,
 * so a refusal never leaves half of the pair installed.
 */
import { lstat, mkdir, readdir, readlink, stat, symlink, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The `skills/` directory of this checkout (or of the installed package). */
export function skillsRoot(): string {
  return join(import.meta.dirname, '..', '..', 'skills');
}

export function skillTarget(home: string, name: string): string {
  return join(home, '.claude', 'skills', name);
}

/** A subdirectory of `root` counts as a skill only if it carries a SKILL.md. */
export async function shippedSkills(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await stat(join(root, entry.name, 'SKILL.md'));
      names.push(entry.name);
    } catch {
      // A directory with no SKILL.md is not a skill; linking it would give Claude nothing to read.
    }
  }
  return names.sort();
}

export interface InstallIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface InstallOptions {
  /** Where the skills come from. Defaults to this checkout's `skills/`. */
  root?: string;
  /** Where the words go. Defaults to stdout and stderr. */
  io?: InstallIo;
}

const STDIO: InstallIo = {
  out: (text) => { process.stdout.write(text); },
  err: (text) => { process.stderr.write(text); },
};

/** What is at a target now: nothing, one of our links, or something that is not ours to touch. */
async function occupant(target: string): Promise<'empty' | 'symlink' | 'other'> {
  try {
    return (await lstat(target)).isSymbolicLink() ? 'symlink' : 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'empty';
    throw error;
  }
}

/** @returns the process exit code: 0 when every skill is linked, 1 when anything was refused */
export async function installSkills(home: string = homedir(), options: InstallOptions = {}): Promise<number> {
  const root = options.root ?? skillsRoot();
  const io = options.io ?? STDIO;

  const names = await shippedSkills(root);
  if (names.length === 0) {
    // Linking nothing and exiting 0 would read as a successful install.
    io.err(`no skills found under ${root} — nothing was linked.\n`);
    return 1;
  }

  const refused: string[] = [];
  for (const name of names) {
    const target = skillTarget(home, name);
    if ((await occupant(target)) === 'other') refused.push(target);
  }
  if (refused.length > 0) {
    for (const target of refused) {
      io.err(
        `refusing to replace ${target}: it is not a symlink, so it is not one this command made. `
          + 'Nothing was deleted. Move it aside yourself if it should be replaced, then run `wpj skills install` again.\n',
      );
    }
    io.err('no skills were linked.\n');
    return 1;
  }

  await mkdir(join(home, '.claude', 'skills'), { recursive: true });
  for (const name of names) {
    const source = join(root, name);
    const target = skillTarget(home, name);
    if ((await occupant(target)) === 'symlink') {
      const previous = await readlink(target);
      // unlink removes the link itself, never what it points at.
      await unlink(target);
      if (previous !== source) io.out(`replaced link ${target} (was -> ${previous})\n`);
    }
    await symlink(source, target, 'dir');
    io.out(`linked ${target} -> ${source}\n`);
  }
  return 0;
}
