/**
 * Decision ids (`R<n>`) appear in comments, tests and docs across the repository. Each one must
 * be explained in docs/decisions.md, so a reader who never saw the working ledger can follow it.
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const ID = /\bR\d{1,3}[a-z]?\b/g;

describe('docs/decisions.md', () => {
  it('has an entry for every decision id referenced in a tracked file', async () => {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0').filter((file) => file !== '' && file !== 'docs/decisions.md' && !file.endsWith('pnpm-lock.yaml'));
    const referenced = new Set<string>();
    for (const file of files) {
      let text: string;
      try {
        text = await readFile(join(ROOT, file), 'utf8');
      } catch {
        continue; // tracked but deleted in the working tree
      }
      for (const match of text.matchAll(ID)) referenced.add(match[0]);
    }
    expect(referenced.size).toBeGreaterThan(20);

    const log = await readFile(join(ROOT, 'docs', 'decisions.md'), 'utf8');
    const entries = new Set([...log.matchAll(/^\| (R\d{1,3}[a-z]?) \|/gm)].map((m) => m[1]!));
    const missing = [...referenced].filter((id) => !entries.has(id)).sort();
    expect(missing).toEqual([]);
  });

  it('gives each entry a plain sentence, and carries no internal paths or agent ids', async () => {
    const log = await readFile(join(ROOT, 'docs', 'decisions.md'), 'utf8');
    for (const [, id, text] of log.matchAll(/^\| (R\d{1,3}[a-z]?) \| (.*) \|$/gm)) {
      expect(text!.trim().length, id).toBeGreaterThan(20);
    }
    expect(log).not.toMatch(/\/home\/|~\/Projects|Kanboard|subagent|\bagent [0-9a-f]{8,}/i);
  });
});
