import { describe, expect, it } from 'vitest';

import type { Finding } from '../src/sentinel/phplog.ts';
import { discountDeclaredDeprecation } from '../src/suite/deprecation.ts';

const CORE = 'in /var/www/html/wp-includes/functions.php on line 6260';
/** Alpaca Bot's real notice, as the log classifier words it. */
const ALPACA: Finding = {
  kind: 'phplog',
  text: `PHP Notice: Function alpacabot_agent was called incorrectly. The [alpacabot_agent] shortcode is deprecated since 0.5.0. ${CORE}`,
};
/** The same notice printed into the body. */
const ALPACA_BODY: Finding = {
  kind: 'bodyscan', url: 'https://s.test/?wpj_render=%5Balpacabot_agent%5D',
  text: `PHP Notice printed into the response body at https://s.test/?wpj_render=%5Balpacabot_agent%5D: Function alpacabot_agent was called incorrectly. The [alpacabot_agent] shortcode is deprecated. ${CORE}`,
};

describe('discountDeclaredDeprecation (R74)', () => {
  it('discounts core\'s deprecation notice naming the declared tag, in the log and in the body', () => {
    expect(discountDeclaredDeprecation([ALPACA, ALPACA_BODY], 'alpacabot_agent'))
      .toEqual({ kept: [], discounted: [ALPACA, ALPACA_BODY] });
  });

  it('discounts every core deprecation helper\'s wording that names the tag as its subject', () => {
    const shapes = [
      `PHP Deprecated: Function acme_old is deprecated since version 2.0 with no alternative available. ${CORE}`,
      `PHP Deprecated: Function acme_old was called with an argument that is deprecated since version 2.0. ${CORE}`,
      `PHP Deprecated: Hook acme_old is deprecated since version 2.0. ${CORE}`,
    ].map((text): Finding => ({ kind: 'phplog', text }));

    expect(discountDeclaredDeprecation(shapes, 'acme_old').kept).toEqual([]);
  });

  it('keeps a deprecation notice naming a DIFFERENT tag — another declaration never reaches it (R80)', () => {
    expect(discountDeclaredDeprecation([ALPACA], 'acme_old').kept).toEqual([ALPACA]);
  });

  it('keeps a notice that names the tag but was not raised by core\'s helpers', () => {
    const own: Finding = {
      kind: 'phplog',
      text: 'PHP Notice: Function alpacabot_agent was called incorrectly. in /var/www/html/wp-content/plugins/alpaca-bot/src/X.php on line 3',
    };
    expect(discountDeclaredDeprecation([own], 'alpacabot_agent').kept).toEqual([own]);
  });

  it('keeps a warning, whatever it says — only a notice or a deprecation is a deprecation', () => {
    const warning: Finding = { kind: 'phplog', text: `PHP Warning: Function alpacabot_agent was called incorrectly. ${CORE}` };
    expect(discountDeclaredDeprecation([warning], 'alpacabot_agent').kept).toEqual([warning]);
  });

  it('keeps every other kind of finding on that render', () => {
    const others: Finding[] = [
      { kind: 'assertion', text: `the shortcode [alpacabot_agent] came back verbatim; Function alpacabot_agent was called incorrectly ${CORE}` },
      { kind: 'response', text: 'HTTP 500 for /?wpj_render=%5Balpacabot_agent%5D', status: 500 },
      { kind: 'phplog', text: `PHP Notice: Undefined index: url in /var/www/html/wp-content/plugins/alpaca-bot/src/Shortcodes/AgentShim.php on line 9` },
    ];
    expect(discountDeclaredDeprecation(others, 'alpacabot_agent').kept).toEqual(others);
  });

  it('does not let a tag that is a prefix of the subject discount it', () => {
    expect(discountDeclaredDeprecation([ALPACA], 'alpacabot').kept).toEqual([ALPACA]);
  });
});
