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
});
