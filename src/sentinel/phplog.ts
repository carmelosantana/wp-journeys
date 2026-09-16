/**
 * Classify one line of `debug.log`.
 *
 * WordPress's defining difference from a framework like Laravel: a PHP notice, warning or
 * deprecation does NOT produce a 5xx. It returns HTTP 200 with the page apparently fine.
 * This classifier is therefore the sentinel's most important signal, not a nice-to-have.
 *
 * Pure: a string in, a Finding or null out.
 */
import { redactLoginToken } from './redact.ts';

/**
 * Which signal produced a finding. Every kind but `assertion` is something the sentinel
 * observed; `assertion` is a journey's own check that failed (a thrown error captured by the
 * lifecycle helper).
 *
 * `pageerror` is an uncaught JavaScript exception or unhandled rejection. Playwright delivers
 * those ONLY as a `pageerror` event, never as a console message, so the console signal alone
 * left a broken admin script reading as ok.
 *
 * A runtime list, so the docs' drift tests can check that every kind is explained.
 */
export const SIGNAL_KINDS = ['response', 'console', 'pageerror', 'requestfailed', 'phplog', 'bodyscan', 'assertion'] as const;

export type SignalKind = typeof SIGNAL_KINDS[number];

/** One thing the sentinel observed that should not have happened. */
export interface Finding {
  kind: SignalKind;
  /** Self-contained, human-readable — it goes straight into the run summary. */
  text: string;
  url?: string;
  status?: number;
}

/*
 * The PHP and wpdb shapes are anchored on their FORMAT — PHP's `[dd-Mon-yyyy HH:MM:SS TZ] `
 * stamp — not on the start of the line. A plugin's `error_log($msg, 3, $log)` appends no
 * newline, so the log tail holds that fragment back and the next diagnostic arrives glued
 * behind it (`acme: sync done[15-Sep-2026 …] PHP Warning: …`). Anchoring at `^` would read
 * that as clean.
 */

/** `[date] PHP <Severity>:  <message>` — the shape PHP's own error handler writes. */
const PHP_DIAGNOSTIC = /\[\d{2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}:\d{2} [^\]]+\]\s*PHP\s+(Warning|Notice|Deprecated|Fatal error|Parse error|Recoverable fatal error|Strict Standards):\s*(.+)$/;

/** WordPress's `_doing_it_wrong()` and `_deprecated_*()` family, which log without the `PHP` prefix. */
const WP_DIAGNOSTIC = /(was called incorrectly|is <?deprecated|Deprecated since version)/i;

/** wpdb's failed-query line (class-wpdb.php), which logs without the `PHP` prefix. */
const WPDB_DIAGNOSTIC = /\[\d{2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}:\d{2} [^\]]+\]\s*(WordPress database error .*for query .*)$/;

/** The leading `[date] ` PHP's error_log() adds. */
const LOG_DATE = /^\[[^\]]*\]\s*/;

/**
 * Summary text: no HTML (core's _doing_it_wrong keeps `<strong>` and `<a>`), no runs of spaces,
 * and no login token — a diagnostic can quote the request URI it was raised on.
 */
function readable(text: string): string {
  return redactLoginToken(text.replace(/<[^>]*>/g, '').replace(/\s{2,}/g, ' ').trim());
}

export function classifyPhpLogLine(line: string): Finding | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  // A stack trace belongs to the diagnostic above it, which is already reported.
  if (trimmed === 'Stack trace:' || /^#\d+\s/.test(trimmed)) return null;

  // Text is taken from the match onward, so a glued fragment never reaches the summary.
  const php = PHP_DIAGNOSTIC.exec(trimmed);
  if (php) {
    return { kind: 'phplog', text: `PHP ${php[1]}: ${readable(php[2]!)}` };
  }

  const wpdb = WPDB_DIAGNOSTIC.exec(trimmed);
  if (wpdb) {
    return { kind: 'phplog', text: readable(wpdb[1]!) };
  }

  if (WP_DIAGNOSTIC.test(trimmed)) {
    return { kind: 'phplog', text: readable(trimmed.replace(LOG_DATE, '')) };
  }

  // Anything else — a developer's own error_log() call, core's auto-update or cron-reschedule
  // log — is not a defect the plugin under test can be blamed for.
  return null;
}
