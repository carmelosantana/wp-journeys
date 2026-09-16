/**
 * A plugin's DECLARED deprecation, discounted on that tag's render only (R74).
 *
 * A shim that announces its own deprecation through core's `_doing_it_wrong()` or
 * `_deprecated_*()` does so on purpose, on every render, and a row that is red for a reason the
 * author chose gets ignored along with the real defects beside it. So a manifest may declare the
 * tag. Only core's own deprecation notice, and only one whose subject IS that tag or whose text
 * quotes `[tag]`, is discounted. Everything else on the render stays a finding, and the caller
 * must SAY what it discounted.
 *
 * Pure. Attribution to one tag is the caller's: a declared tag renders on its own journey, with
 * its own sentinel and log window (R80), so nothing here can reach another tag's findings.
 */
import type { Finding } from '../sentinel/phplog.ts';

/** Core's helpers, and only core's: the notice is raised in wp-includes/functions.php. */
const RAISED_BY_CORE = /\/wp-includes\/functions\.php on line \d+/;

/** A notice or a deprecation — never a warning or worse. */
const SEVERITY = /^PHP (?:Notice|Deprecated)\b/;

/**
 * The subject of core's deprecation wordings: "Function X was called incorrectly", "Function X
 * is deprecated", "Function X was called with an argument that is deprecated", "Hook X is
 * deprecated", "File X is deprecated", "Class X is deprecated", "The called constructor method
 * for X class".
 */
const SUBJECT = /\b(?:(?:Function|Hook|File|Class) (\S+?) (?:is deprecated|was called)|The called constructor method for (\S+?) class)\b/;

function isDeclaredDeprecation(finding: Finding, tag: string): boolean {
  if (finding.kind !== 'phplog' && finding.kind !== 'bodyscan') return false;
  // The bodyscan text opens with where it was printed; the diagnostic follows the first ": ".
  const text = finding.kind === 'bodyscan'
    ? finding.text.replace(/^PHP (\w+(?: \w+)?) printed into the response body at \S*: /, 'PHP $1: ')
    : finding.text;
  if (!SEVERITY.test(text) || !RAISED_BY_CORE.test(text)) return false;
  const match = SUBJECT.exec(text);
  if (!match) return false;
  const subject = match[1] ?? match[2];
  return subject === tag || text.includes(`[${tag}]`);
}

export function discountDeclaredDeprecation(
  findings: readonly Finding[], tag: string,
): { kept: Finding[]; discounted: Finding[] } {
  const kept: Finding[] = [];
  const discounted: Finding[] = [];
  for (const finding of findings) (isDeclaredDeprecation(finding, tag) ? discounted : kept).push(finding);
  return { kept, discounted };
}
