/**
 * Find and parse a plugin's manifest. Absent is fine; malformed is not.
 *
 * "Absent" means exactly ENOENT. Any other read failure — a directory where the file should
 * be, a permission problem — is an author who WROTE a manifest and would otherwise have none
 * of it run, silently, which is the false green this file exists to refuse.
 */
import type { Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { messageOf } from '../errors.ts';
import { parseManifest, type Manifest } from './schema.ts';

const MANIFEST_FILE = 'wp-journeys.json';

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * @param manifestDir the directory holding `wp-journeys.json` — which on a real plugin is not
 *   necessarily the plugin root that was mounted (R70; Alpaca Bot keeps it in `tests/e2e`).
 */
export async function loadManifest(manifestDir: string): Promise<Manifest | null> {
  // The DIRECTORY first: readFile answers ENOENT for a missing directory exactly as for a
  // missing file, and a mistyped path would otherwise read as "no manifest".
  let directory: Stats;
  try {
    directory = await stat(manifestDir);
  } catch (error) {
    throw new Error(`${manifestDir}: manifest directory does not exist — ${messageOf(error)}`);
  }
  if (!directory.isDirectory()) throw new Error(`${manifestDir}: manifest directory is not a directory`);

  const file = join(manifestDir, MANIFEST_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    // Genuinely absent: the plugin gets the zero-authoring core suite and nothing else.
    if (isMissing(error)) return null;
    throw new Error(`${file}: could not be read — ${messageOf(error)}`);
  }
  // From here on every failure is loud: the author intended journeys to run.
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: invalid JSON — ${messageOf(error)}`);
  }
  return parseManifest(raw, file);
}
