import { describe, expect, it } from 'vitest';

import { classifyPhpLogLine } from '../src/sentinel/phplog.ts';

describe('classifyPhpLogLine', () => {
  it('flags a PHP warning, which returns HTTP 200 and would otherwise be invisible', () => {
    const line = '[08-Sep-2026 14:02:11 UTC] PHP Warning:  Undefined array key "id" in /var/www/html/wp-content/plugins/acme/acme.php on line 42';
    expect(classifyPhpLogLine(line)).toEqual({
      kind: 'phplog',
      text: 'PHP Warning: Undefined array key "id" in /var/www/html/wp-content/plugins/acme/acme.php on line 42',
    });
  });

  it('flags notices, deprecations, fatals and parse errors', () => {
    for (const severity of ['Notice', 'Deprecated', 'Fatal error', 'Parse error', 'Recoverable fatal error']) {
      const line = `[08-Sep-2026 14:02:11 UTC] PHP ${severity}:  something in /x.php on line 1`;
      expect(classifyPhpLogLine(line), severity).not.toBeNull();
    }
  });

  it('flags WordPress’s own _doing_it_wrong and deprecation notices', () => {
    const line = '[08-Sep-2026 14:02:11 UTC] Function wp_get_current_user was called incorrectly.';
    expect(classifyPhpLogLine(line)?.kind).toBe('phplog');
  });

  it('ignores a blank line and a bare stack-trace frame', () => {
    expect(classifyPhpLogLine('')).toBeNull();
    expect(classifyPhpLogLine('   ')).toBeNull();
    expect(classifyPhpLogLine('#0 /var/www/html/wp-includes/plugin.php(205): acme_boot()')).toBeNull();
    expect(classifyPhpLogLine('Stack trace:')).toBeNull();
  });

  it('ignores an ordinary error_log() line a developer wrote on purpose', () => {
    expect(classifyPhpLogLine('[08-Sep-2026 14:02:11 UTC] acme: syncing 12 items')).toBeNull();
  });

  it('ignores the automatic-update lines WordPress core itself writes to debug.log', () => {
    // Verbatim from wpjtest's debug.log: core logs these on every auto-update run. Flagging them
    // would give every run on an auto-updating site a phantom phplog finding.
    expect(classifyPhpLogLine('[15-Sep-2026 22:37:18 UTC] Automatic updates starting...')).toBeNull();
    expect(classifyPhpLogLine('[15-Sep-2026 22:37:18 UTC] Automatic updates complete.')).toBeNull();
  });

  it('flags a wpdb query error, which has no PHP prefix and also returns HTTP 200', () => {
    // Verbatim from wpjtest's debug.log after a query against a missing table (class-wpdb.php).
    const line = "[15-Sep-2026 23:04:46 UTC] WordPress database error Table 'wordpress.wpj_no_such_table' doesn't exist for query SELECT wpj_probe FROM wpj_no_such_table made by include('phar:///usr/local/bin/wp/php/boot-phar.php'), Eval_Command->__invoke, eval";
    expect(classifyPhpLogLine(line)).toEqual({
      kind: 'phplog',
      text: "WordPress database error Table 'wordpress.wpj_no_such_table' doesn't exist for query SELECT wpj_probe FROM wpj_no_such_table made by include('phar:///usr/local/bin/wp/php/boot-phar.php'), Eval_Command->__invoke, eval",
    });
  });

  it('strips the HTML core keeps in a _doing_it_wrong notice, so the summary reads as text', () => {
    // Verbatim from wpjtest's debug.log after _doing_it_wrong("wpj_probe", "wpj probe.", "1.0").
    const line = '[15-Sep-2026 23:04:44 UTC] PHP Notice:  Function wpj_probe was called <strong>incorrectly</strong>. wpj probe. Please see <a href="https://developer.wordpress.org/advanced-administration/debug/debug-wordpress/">Debugging in WordPress</a> for more information. (This message was added in version 1.0.) in /var/www/html/wp-includes/functions.php on line 6260';
    expect(classifyPhpLogLine(line)).toEqual({
      kind: 'phplog',
      text: 'PHP Notice: Function wpj_probe was called incorrectly. wpj probe. Please see Debugging in WordPress for more information. (This message was added in version 1.0.) in /var/www/html/wp-includes/functions.php on line 6260',
    });
  });

  it('flags a PHP warning glued behind a newline-less error_log($msg, 3, $log) fragment', () => {
    // error_log() type 3 appends no newline, so the log tail holds the fragment back and the
    // next diagnostic arrives glued to it. The finding must still be seen, without the fragment.
    const line = 'acme: sync done[15-Sep-2026 23:12:24 UTC] PHP Warning:  Undefined array key "id" in /var/www/html/wp-content/plugins/acme/acme.php on line 42';
    expect(classifyPhpLogLine(line)).toEqual({
      kind: 'phplog',
      text: 'PHP Warning: Undefined array key "id" in /var/www/html/wp-content/plugins/acme/acme.php on line 42',
    });
  });

  it('flags a wpdb query error glued behind a newline-less fragment', () => {
    const line = "acme: sync done[15-Sep-2026 23:12:25 UTC] WordPress database error Table 'wordpress.wpj_no_such_table' doesn't exist for query SELECT wpj_probe FROM wpj_no_such_table made by acme_sync";
    expect(classifyPhpLogLine(line)).toEqual({
      kind: 'phplog',
      text: "WordPress database error Table 'wordpress.wpj_no_such_table' doesn't exist for query SELECT wpj_probe FROM wpj_no_such_table made by acme_sync",
    });
  });

  it('ignores core’s own cron reschedule error, which no plugin under test can be blamed for', () => {
    // The format of wp-cron.php's error_log() call; not plugin-attributable (R34).
    const line = '[15-Sep-2026 23:10:00 UTC] Cron reschedule event error for hook: wpj_fixture_daily, Error code: could_not_set, Error message: The cron event list could not be saved., Data: {"schedule":"daily","args":[],"interval":86400}';
    expect(classifyPhpLogLine(line)).toBeNull();
  });
});
