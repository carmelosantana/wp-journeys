/**
 * Classify one line of `debug.log`.
 *
 * WordPress's defining difference from a framework like Laravel: a PHP notice, warning or
 * deprecation does NOT produce a 5xx. It returns HTTP 200 with the page apparently fine.
 * This classifier is therefore the sentinel's most important signal, not a nice-to-have.
 *
 * Pure: a string in, a Finding or null out.
 */

/**
 * Which signal produced a finding. Every kind but `assertion` is something the sentinel
 * observed; `assertion` is a journey's own check that failed (a thrown error captured by the
 * lifecycle helper).
 */
export type SignalKind = 'response' | 'console' | 'requestfailed' | 'phplog' | 'bodyscan' | 'assertion';

/** One thing the sentinel observed that should not have happened. */
export interface Finding {
  kind: SignalKind;
  /** Self-contained, human-readable — it goes straight into the run summary. */
  text: string;
  url?: string;
  status?: number;
}

/** `[date] PHP <Severity>:  <message>` — the shape PHP's own error handler writes. */
const PHP_DIAGNOSTIC = /^\[[^\]]*\]\s*PHP\s+(Warning|Notice|Deprecated|Fatal error|Parse error|Recoverable fatal error|Strict Standards):\s*(.+)$/;

/** WordPress's `_doing_it_wrong()` and `_deprecated_*()` family, which log without the `PHP` prefix. */
const WP_DIAGNOSTIC = /(was called incorrectly|is <?deprecated|Deprecated since version)/i;

export function classifyPhpLogLine(line: string): Finding | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  // A stack trace belongs to the diagnostic above it, which is already reported.
  if (trimmed === 'Stack trace:' || /^#\d+\s/.test(trimmed)) return null;

  const php = PHP_DIAGNOSTIC.exec(trimmed);
  if (php) {
    return { kind: 'phplog', text: `PHP ${php[1]}: ${php[2]!.replace(/\s{2,}/g, ' ').trim()}` };
  }

  if (WP_DIAGNOSTIC.test(trimmed)) {
    // Strip the leading `[date] ` so the summary line stays readable.
    return { kind: 'phplog', text: trimmed.replace(/^\[[^\]]*\]\s*/, '') };
  }

  // Anything else — a developer's own error_log() call, core's auto-update log — is not a defect.
  return null;
}
