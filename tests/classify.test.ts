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
  /** The first diagnostic in a body, for the many cases that only care whether one was found. */
  const first = (body: string, url = '/') => scanBody(body, url)[0] ?? null;

  it('flags a PHP warning printed into the response body, which returns HTTP 200', () => {
    const body = '<br />\n<b>Warning</b>:  Undefined variable $x in <b>/acme.php</b> on line <b>7</b><br />\n<html>';
    expect(first(body)?.kind).toBe('bodyscan');
  });

  it('returns EVERY diagnostic in the body, not only the first (R64)', () => {
    // The lost signal this closes. A site whose per-request noise renders early — a wp_head
    // warning — makes that noise the one match. It is then correctly subtracted as noise, and a
    // plugin's genuine diagnostic further down the SAME render never becomes a finding at all.
    // Under display-only settings with no debug.log, bodyscan is the only signal, so nothing
    // backstops it: the journey reports ok having seen a real defect and discarded it.
    const body =
      '<br />\n<b>Warning</b>:  Undefined variable $notset in <b>/wp-content/themes/acme/header.php</b> on line <b>8</b><br />\n'
      + '<p>page content</p>\n'
      + '<br />\n<b>Warning</b>:  Undefined array key "id" in <b>/wp-content/plugins/acme/admin.php</b> on line <b>12</b><br />';

    const findings = scanBody(body, 'https://s.test/');

    expect(findings).toHaveLength(2);
    expect(findings[0]?.text).toContain('Undefined variable $notset');
    expect(findings[1]?.text).toContain('Undefined array key "id"');
  });

  describe('a plain-text diagnostic printed BEFORE any markup (first contact, Alpaca Bot)', () => {
    // The sentinel scans page.content(), the browser's serialisation, not the bytes PHP sent.
    // PHP printed "\nNotice: ..." ahead of everything; the HTML parser drops that leading
    // newline and puts the text straight after an IMPLIED <body>. A `^`-anchored match never
    // sees it — and under WP_DEBUG_LOG off, bodyscan is the only signal there is. Observed live:
    // the raw body matched, the serialised DOM of the same response did not.
    const notice = 'Notice: Function alpacabot_agent was called <strong>incorrectly</strong>. The shortcode is deprecated. '
      + 'Please see <a href="https://developer.wordpress.org/">Debugging in WordPress</a> for more information. '
      + '(This message was added in version 0.5.0.) in /var/www/html/wp-includes/functions.php on line 6260';

    it('is found directly after the implied <body>, exactly as Chromium serialised it', () => {
      const dom = `<html><head></head><body>${notice}\n<div data-wpj-render="1"><p>ok</p></div></body></html>`;

      const findings = scanBody(dom, 'https://s.test/');

      expect(findings).toHaveLength(1);
      expect(findings[0]?.text).toContain('Function alpacabot_agent was called incorrectly');
      expect(findings[0]?.text).toContain('functions.php on line 6260');
    });

    it('is found when the page\'s own <body> tag later merged its attributes onto that element', () => {
      // A themed page: PHP's text arrives first, the parser opens a body for it, and the
      // template's <body class="home"> then lends that SAME element its attributes.
      const dom = `<html><head><title>x</title></head><body class="home page" data-x="1">${notice}\n<header>site</header></body></html>`;

      expect(scanBody(dom, 'https://s.test/')).toHaveLength(1);
    });

    it('still refuses prose that merely starts with a severity word after a tag', () => {
      // The adjacency rule is what keeps this safe: no "in <path> on line <n>" follows.
      const dom = '<html><head></head><body>Warning: this store closes early on Fridays. See the note on line 3.</body></html>';

      expect(scanBody(dom, 'https://s.test/')).toEqual([]);
    });
  });

  it('reports a repeated identical diagnostic once, so a loop does not multiply it', () => {
    // A diagnostic inside a `foreach` prints once per row. They are one defect, and the key that
    // distinguishes two different diagnostics is the same one that recognises these as the same.
    const line = 'Warning: Undefined array key "id" in /acme.php on line 7';
    const findings = scanBody(`${line}\n${line}\n${line}\n`, '/');

    expect(findings).toHaveLength(1);
  });

  it('finds a later fatal even when a warning rendered first', () => {
    // The ordering that matters most: a warning is survivable, an uncaught fatal is not, and the
    // fatal is always the one that renders last.
    const body =
      'Warning: Undefined variable $x in /wp-content/themes/acme/header.php on line 8\n'
      + 'Fatal error: Uncaught Error: Call to undefined function acme()\n';

    expect(scanBody(body, '/').map((f) => f.text)).toEqual([
      expect.stringContaining('Undefined variable $x'),
      expect.stringContaining('Uncaught Error: Call to undefined function acme()'),
    ]);
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
    expect(first(body)?.kind).toBe('bodyscan');
  });

  it('flags a plain-text diagnostic when html_errors is off', () => {
    expect(first('Warning: Undefined variable $x in /var/www/html/acme.php on line 7\n')).not.toBeNull();
  });

  it('flags the shutdown fatal, whose file position is the literal "Unknown"', () => {
    // PHP reports no file for a stream-open/shutdown fatal, so there is no path to anchor on.
    // This is the case that renders a broken page with no other on-page signal.
    const body = 'Fatal error: Unknown: Failed to open stream: No such file or directory in Unknown on line 0';
    expect(first(body)).not.toBeNull();
  });

  it('does not flag prose containing "in Unknown ... on line" — adjacency is what saves it', () => {
    const body = '<p>Warning: this track is filed in Unknown Artist; see the note on line 3.</p>';
    expect(scanBody(body, '/')).toEqual([]);
  });

  it('flags a fatal error printed into the body', () => {
    expect(first('Fatal error: Uncaught Error: Call to undefined function acme()')).not.toBeNull();
  });

  it('does not flag a page that merely uses the word warning in its copy', () => {
    expect(scanBody('<p>Warning: this action cannot be undone.</p>', '/')).toEqual([]);
  });

  it('does not flag prose whose page happens to say "on line" somewhere else', () => {
    // A merely-widened character bound fails this. Anchoring on PHP's output format does not.
    const body = '<p>Warning: this action cannot be undone.</p><footer>Edited on line 3 of the draft.</footer>';
    expect(scanBody(body, '/')).toEqual([]);
  });

  it('does not flag marketing copy about a deprecated feature', () => {
    expect(scanBody('<div>Notice: This feature is deprecated and will be removed.</div>', '/')).toEqual([]);
  });

  it('does not flag an empty body', () => {
    expect(scanBody('', '/')).toEqual([]);
  });

  it('names the severity it found, so the summary line is self-contained', () => {
    expect(first('Fatal error: Uncaught Error: boom', '/wp-admin/')?.text)
      .toBe('PHP Fatal error printed into the response body at /wp-admin/: Uncaught Error: boom');
  });

  it('carries the MESSAGE, FILE and LINE it matched, not just the severity (R63)', () => {
    // The finding text is the only thing downstream has to tell one body diagnostic from
    // another. `withoutBaselineNoise` keys on it with the URL stripped, so a text built from
    // severity and URL alone reduces to the bare severity word — and every `Warning` the site
    // ever printed collapses into one key, subtracting real defects run-wide.
    const finding = first(
      'Warning: Undefined array key "id" in /wp-content/plugins/acme/admin.php on line 12\n',
      'https://s.test/wp-admin/admin.php?page=acme',
    );

    expect(finding?.text).toContain('Undefined array key "id"');
    expect(finding?.text).toContain('/wp-content/plugins/acme/admin.php');
    expect(finding?.text).toContain('on line 12');
  });

  it('gives two DIFFERENT warnings on one URL two different texts (R63)', () => {
    // The discriminating property, stated directly. Same severity, same URL, different defect:
    // if these two texts are equal then the noise key cannot separate them and neither can the
    // sentinel's own de-duplication.
    const url = 'https://s.test/';
    const theme = first('Warning: Undefined variable $notset in /wp-content/themes/acme/header.php on line 8\n', url);
    const plugin = first('Warning: Undefined array key "id" in /wp-content/plugins/acme/admin.php on line 12\n', url);

    expect(theme?.text).not.toBe(plugin?.text);
  });

  it('normalises the html_errors=1 form, so markup never reaches the summary', () => {
    const body = '<br />\n<b>Warning</b>:  Undefined variable $x in <b>/acme.php</b> on line <b>7</b><br />';
    const finding = first(body);

    expect(finding?.text).toBe(
      'PHP Warning printed into the response body at /: Undefined variable $x in /acme.php on line 7',
    );
    expect(finding?.text).not.toContain('<b>');
  });

  it('redacts a minted token that appears in the MESSAGE, not only in the url (R51)', () => {
    // A diagnostic can quote the request URI it was raised on, which at the login step carries
    // the token. Redacting only the `url` field would still write the credential into `text`.
    // The token sits INSIDE the matched span — before the ` in <path> on line N` the pattern
    // anchors on — so it really does reach the message, rather than being trimmed off by luck.
    const finding = first(
      'Warning: Undefined array key "/?wpj_login=SECRETTOKENabcdef0123456789abcd" in /acme.php on line 1\n',
    );

    expect(finding?.text).toContain('<REDACTED>');
    expect(JSON.stringify(finding)).not.toContain('SECRETTOKEN');
  });
});
