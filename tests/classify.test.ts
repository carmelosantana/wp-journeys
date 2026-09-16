import { describe, expect, it } from 'vitest';

import {
  classifyConsole, classifyNavigation, classifyRequestFailed, classifyResponse, scanBody,
} from '../src/sentinel/classify.ts';

const allowed = { denyExpected: false };
const denyExpected = { denyExpected: true };

describe('classifyResponse', () => {
  it('flags a 5xx', () => {
    expect(classifyResponse(500, '/wp-admin/admin.php?page=acme')).toEqual({
      kind: 'response', status: 500, url: '/wp-admin/admin.php?page=acme',
      text: 'HTTP 500 response from /wp-admin/admin.php?page=acme',
    });
  });

  it('leaves a 200 and a SUBRESOURCE 404 alone — a missing favicon is not a defect', () => {
    expect(classifyResponse(200, '/')).toBeNull();
    expect(classifyResponse(404, '/nope')).toBeNull();
  });

  it('leaves a SUBRESOURCE 403 alone — on a correctly denied page every asset answers 403', () => {
    // The subresource policy takes no expectation at all (R1). Applying `denyExpected` here
    // would turn each 2xx asset on a 403 page into "expected a denial but got HTTP 200", and
    // every unpermitted-actor journey would fail. The document's status is classifyNavigation's.
    expect(classifyResponse(403, '/wp-content/plugins/acme/acme.css')).toBeNull();
    expect(classifyResponse(401, '/wp-content/plugins/acme/acme.css')).toBeNull();
  });
});

describe('classifyNavigation', () => {
  it('flags a 404 on the document the journey asked for', () => {
    // The subresource policy deliberately lets this pass; the main document must not. A
    // mistyped admin URL is exactly this, and would otherwise be a silent green.
    expect(classifyNavigation(404, '/wp-admin/admin.php?page=acme', allowed)?.status).toBe(404);
  });

  it('flags a 502 — a stopped container renders an error page that reads as content', () => {
    expect(classifyNavigation(502, '/', allowed)?.kind).toBe('response');
  });

  it('passes a 2xx', () => {
    expect(classifyNavigation(200, '/', allowed)).toBeNull();
  });

  it('passes an expected denial, and fails a denial that did not happen', () => {
    expect(classifyNavigation(403, '/wp-admin/admin.php?page=acme', denyExpected)).toBeNull();
    expect(classifyNavigation(401, '/wp-admin/admin.php?page=acme', denyExpected)).toBeNull();
    expect(classifyNavigation(200, '/wp-admin/admin.php?page=acme', denyExpected)?.text)
      .toContain('expected a permission denial');
  });

  it('passes a denial WordPress served as a login redirect, which is how it denies a logged-out user', () => {
    // A logged-out request for an admin screen gets a 302 to wp-login.php and ends 200. It
    // never gets a 403, so a denial test that only accepts 401/403 can never pass.
    expect(classifyNavigation(200, 'https://s.test/wp-login.php?redirect_to=%2Fwp-admin%2F', denyExpected))
      .toBeNull();
  });

  it('flags an authenticated navigation bounced to the login page — a failed login reads as a clean 2xx', () => {
    const finding = classifyNavigation(200, 'https://s.test/wp-login.php?redirect_to=%2Fwp-admin%2F', allowed);
    expect(finding?.text).toBe(
      'redirected to the login page at https://s.test/wp-login.php?redirect_to=%2Fwp-admin%2F — the actor is not authenticated',
    );
  });

  it('decides the login page on the PATHNAME, so a lookalike URL is not mistaken for one', () => {
    for (const url of [
      'https://s.test/wp-login.php',
      'https://s.test/wp-login.php?redirect_to=%2Fwp-admin%2F',
      'https://s.test/sub/wp-login.php',
    ]) {
      expect(classifyNavigation(200, url, allowed), url).not.toBeNull();
      expect(classifyNavigation(200, url, denyExpected), url).toBeNull();
    }
    for (const url of ['https://s.test/wp-login.php.bak', 'https://s.test/?x=wp-login.php']) {
      expect(classifyNavigation(200, url, allowed), url).toBeNull();
      expect(classifyNavigation(200, url, denyExpected), url).not.toBeNull();
    }
  });
});

describe('a minted login token never reaches a finding (R51)', () => {
  // The runner navigates to `?wpj_login=<token>` to authenticate an actor. Any finding built
  // from that URL carries a live credential into JourneyResult, the summary and CI logs.
  const TOKEN_URL = 'https://s.test/?wpj_login=SECRETTOKENabcdef0123456789abcd';

  it('redacts the token from a navigation finding', () => {
    const finding = classifyNavigation(502, TOKEN_URL, allowed);
    expect(JSON.stringify(finding)).not.toContain('SECRETTOKEN');
    expect(finding?.url).toBe('https://s.test/?wpj_login=<REDACTED>');
  });

  it('redacts the token from a 5xx response finding', () => {
    const finding = classifyResponse(500, TOKEN_URL);
    expect(JSON.stringify(finding)).not.toContain('SECRETTOKEN');
  });

  it('redacts the token from a failed-request and a body-scan finding', () => {
    expect(JSON.stringify(classifyRequestFailed(TOKEN_URL, 'net::ERR_CONNECTION_REFUSED', false)))
      .not.toContain('SECRETTOKEN');
    expect(JSON.stringify(scanBody('Fatal error: Uncaught Error: boom', TOKEN_URL)))
      .not.toContain('SECRETTOKEN');
  });

  it('leaves an ordinary query string alone', () => {
    expect(classifyNavigation(404, 'https://s.test/?page_id=2&preview=true', allowed)?.url)
      .toBe('https://s.test/?page_id=2&preview=true');
  });
});

describe('classifyConsole', () => {
  it('flags a genuine console error', () => {
    expect(classifyConsole('error', 'Uncaught TypeError: x is not a function')?.kind).toBe('console');
  });

  it('ignores logs, warnings and info', () => {
    for (const type of ['log', 'warning', 'info', 'debug']) {
      expect(classifyConsole(type, 'anything'), type).toBeNull();
    }
  });

  it('suppresses Chromium’s echo of a sub-500 resource load, which the response signal already owns', () => {
    expect(classifyConsole('error', 'Failed to load resource: the server responded with a status of 403 ()')).toBeNull();
  });

  it('keeps the echo when it is a 5xx', () => {
    expect(classifyConsole('error', 'Failed to load resource: the server responded with a status of 500 ()')).not.toBeNull();
  });

  it('ignores ERR_NETWORK_CHANGED, which this runner causes itself by running wp-cli mid-run', () => {
    expect(classifyConsole('error', 'Failed to load resource: net::ERR_NETWORK_CHANGED')).toBeNull();
  });
});

describe('classifyRequestFailed', () => {
  it('flags a request that never got a response', () => {
    expect(classifyRequestFailed('/x', 'net::ERR_CONNECTION_REFUSED', false)?.kind).toBe('requestfailed');
  });

  it('ignores an aborted request that did receive a response', () => {
    expect(classifyRequestFailed('/x', 'net::ERR_ABORTED', true)).toBeNull();
  });

  it('ignores ERR_NETWORK_CHANGED even with no response — it is environment noise', () => {
    expect(classifyRequestFailed('/x', 'net::ERR_NETWORK_CHANGED', false)).toBeNull();
  });

  it('still flags a genuine connection refusal', () => {
    expect(classifyRequestFailed('/x', 'net::ERR_CONNECTION_REFUSED', false)).not.toBeNull();
  });
});

describe('scanBody', () => {
  it('flags a PHP warning printed into the response body, which returns HTTP 200', () => {
    const body = '<br />\n<b>Warning</b>:  Undefined variable $x in <b>/acme.php</b> on line <b>7</b><br />\n<html>';
    expect(scanBody(body, '/')?.kind).toBe('bodyscan');
  });

  it('flags WordPress _doing_it_wrong, whose message runs to ~345 characters', () => {
    // The regression that matters: ANY length-bounded pattern misses this. WordPress appends a
    // docs link and a "(This message was added in version X.)" sentence before `in ... on line`.
    const body =
      '<br />\n<b>Warning</b>:  Function wp_get_current_user was called incorrectly. ' +
      'Conditional query tags do not work before the query is run. Before then, they always ' +
      'return false. Please see <a href="https://developer.wordpress.org/advanced-administration/debug/debug-wordpress/">' +
      'Debugging in WordPress</a> for more information. (This message was added in version 3.1.0.) ' +
      'in <b>/var/www/html/wp-includes/functions.php</b> on line <b>6114</b><br />';
    expect(scanBody(body, '/')?.kind).toBe('bodyscan');
  });

  it('flags a plain-text diagnostic when html_errors is off', () => {
    expect(scanBody('Warning: Undefined variable $x in /var/www/html/acme.php on line 7\n', '/')).not.toBeNull();
  });

  it('flags the shutdown fatal, whose file position is the literal "Unknown"', () => {
    // PHP reports no file for a stream-open/shutdown fatal, so there is no path to anchor on.
    // This is the case that renders a broken page with no other on-page signal.
    const body = 'Fatal error: Unknown: Failed to open stream: No such file or directory in Unknown on line 0';
    expect(scanBody(body, '/')).not.toBeNull();
  });

  it('does not flag prose containing "in Unknown ... on line" — adjacency is what saves it', () => {
    const body = '<p>Warning: this track is filed in Unknown Artist; see the note on line 3.</p>';
    expect(scanBody(body, '/')).toBeNull();
  });

  it('flags a fatal error printed into the body', () => {
    expect(scanBody('Fatal error: Uncaught Error: Call to undefined function acme()', '/')).not.toBeNull();
  });

  it('does not flag a page that merely uses the word warning in its copy', () => {
    expect(scanBody('<p>Warning: this action cannot be undone.</p>', '/')).toBeNull();
  });

  it('does not flag prose whose page happens to say "on line" somewhere else', () => {
    // A merely-widened character bound fails this. Anchoring on PHP's output format does not.
    const body = '<p>Warning: this action cannot be undone.</p><footer>Edited on line 3 of the draft.</footer>';
    expect(scanBody(body, '/')).toBeNull();
  });

  it('does not flag marketing copy about a deprecated feature', () => {
    expect(scanBody('<div>Notice: This feature is deprecated and will be removed.</div>', '/')).toBeNull();
  });

  it('does not flag an empty body', () => {
    expect(scanBody('', '/')).toBeNull();
  });

  it('names the severity it found, so the summary line is self-contained', () => {
    expect(scanBody('Fatal error: Uncaught Error: boom', '/wp-admin/')?.text)
      .toBe('PHP Fatal error printed into the response body at /wp-admin/');
  });
});
