import { describe, expect, it } from 'vitest';

import {
  RENDER_SIGNATURE_TTL, blockRenderVerdict, blockRenderUrl, renderSignature, shortcodeRenderDefect, shortcodeRenderUrl,
  signRenderDoor,
} from '../src/agent/render.ts';

/** A dummy secret used only by the tests; it is not any site's secret. */
const SECRET = 'dummy-vector-secret-not-real-0123';
const NOW = 1700000000;

/**
 * THE SHARED VECTOR. tests/php/render.test.php asserts the same inputs give the same hex in PHP,
 * which is what pins the two computations to each other.
 */
const VECTOR = '6510d389cb84d523b408e3ec71d45eafef56843ce4008ea63a3f0924a0526ed3';

describe('renderSignature', () => {
  it('signs the shared test vector to the hex the PHP agent computes', () => {
    expect(renderSignature('wpj_render', '[wpj_fixture]', '1700000300', SECRET)).toBe(VECTOR);
  });

  it('binds the door as well as the payload', () => {
    expect(renderSignature('wpj_render_block', 'wpj-fixture/dynamic', '1700000300', SECRET))
      .toBe('63a9625886e81437539466a0bfdf44674d3861a584583aa505e4be0fdfe86ed2');
  });
});

/** The agent's marker as Chromium serialises it, around what do_shortcode() returned. */
const rendered = (expanded: '0' | '1', inner: string) =>
  `<html><head></head><body><div data-wpj-render="1" data-wpj-expanded="${expanded}">${inner}</div></body></html>`;

describe('shortcodeRenderUrl', () => {
  it('asks the render door for exactly one bare tag, signed and expiring', () => {
    expect(shortcodeRenderUrl('wpj_fixture', SECRET, NOW))
      .toBe(`/?wpj_render=%5Bwpj_fixture%5D&wpj_exp=1700000300&wpj_sig=${VECTOR}`);
  });

  it('expires inside the agent\'s 600-second cap', () => {
    expect(RENDER_SIGNATURE_TTL).toBeGreaterThan(0);
    expect(RENDER_SIGNATURE_TTL).toBeLessThanOrEqual(600);
  });

  it('signs against the clock when no time is given', () => {
    const before = Math.floor(Date.now() / 1000);
    const exp = Number(/wpj_exp=(\d+)/.exec(shortcodeRenderUrl('acme', SECRET))?.[1]);
    expect(exp).toBeGreaterThanOrEqual(before + RENDER_SIGNATURE_TTL);
    expect(exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + RENDER_SIGNATURE_TTL);
  });
});

describe('shortcodeRenderDefect', () => {
  it('passes a tag the agent says expanded', () => {
    expect(shortcodeRenderDefect(rendered('1', '<p>hello</p>'), 'acme')).toBeNull();
  });

  it('passes an expanded shortcode whose OUTPUT quotes its own tag (first contact, Alpaca Bot)', () => {
    // [alpacabot_agent] with no url answers "[alpacabot_agent] needs a url attribute." — it
    // expanded perfectly, and a substring test for "[alpacabot_agent]" called it verbatim.
    const html = rendered('1', '<p class="alpaca-bot-notice">[alpacabot_agent] needs a url attribute.</p>');

    expect(shortcodeRenderDefect(html, 'alpacabot_agent')).toBeNull();
  });

  it('fails a tag the agent says came back unchanged — WordPress returns an unregistered one verbatim', () => {
    expect(shortcodeRenderDefect(rendered('0', '[acme]'), 'acme')).toMatch(/the shortcode \[acme\] came back verbatim/);
  });

  it('fails when the marker is absent — the endpoint never ran', () => {
    expect(shortcodeRenderDefect('<html><body>home</body></html>', 'acme'))
      .toMatch(/rendering \[acme\] produced no wp-journeys render marker/);
  });

  it('fails, rather than guessing, when the marker does not say whether the tag expanded', () => {
    // An agent older than this runner. Falling back to the substring test would reinstate the
    // false defect above; passing would assert nothing about expansion at all.
    expect(shortcodeRenderDefect('<div data-wpj-render="1"><p>x</p></div>', 'acme'))
      .toMatch(/does not say whether \[acme\] expanded/);
  });
});

/** The block door's marker as Chromium serialises it. */
const block = (registered: '0' | '1', dynamic: '0' | '1', inner = '') =>
  `<html><head></head><body><div data-wpj-render-block="1" data-wpj-registered="${registered}" `
  + `data-wpj-dynamic="${dynamic}">${inner}</div></body></html>`;

describe('blockRenderUrl', () => {
  it('asks the block door for one block by name', () => {
    expect(blockRenderUrl('wpj-fixture/dynamic', SECRET, NOW)).toBe(
      '/?wpj_render_block=wpj-fixture%2Fdynamic&wpj_exp=1700000300&wpj_sig=63a9625886e81437539466a0bfdf44674d3861a584583aa505e4be0fdfe86ed2',
    );
  });
});

describe('blockRenderVerdict (R57, R78)', () => {
  it('passes a registered dynamic block the server rendered, and says it is dynamic', () => {
    expect(blockRenderVerdict(block('1', '1', '<p>hello</p>'), 'acme/hello')).toEqual({ defect: null, dynamic: true });
  });

  it('passes a registered static block, and says it is static so the row can say what was not checked', () => {
    expect(blockRenderVerdict(block('1', '0'), 'acme/static')).toEqual({ defect: null, dynamic: false });
  });

  it('fails a block the registry does not know — render_block answers an unknown one with nothing, not an error', () => {
    expect(blockRenderVerdict(block('0', '0'), 'acme/gone').defect).toMatch(/acme\/gone is not registered/);
  });

  it('fails when the marker is absent — the endpoint never ran', () => {
    expect(blockRenderVerdict('<html><body>home</body></html>', 'acme/hello').defect)
      .toMatch(/rendering the block acme\/hello produced no wp-journeys render marker/);
  });

  it('does not accept the SHORTCODE door\'s marker as proof a block rendered', () => {
    expect(blockRenderVerdict(rendered('1', '<p>x</p>'), 'acme/hello').defect).toMatch(/no wp-journeys render marker/);
  });

  it('fails, rather than guessing, when the marker does not say whether the block is registered', () => {
    expect(blockRenderVerdict('<div data-wpj-render-block="1"></div>', 'acme/hello').defect)
      .toMatch(/does not say whether acme\/hello is registered/);
  });

  it('fails, rather than guessing, when the marker does not say whether the block is dynamic', () => {
    expect(blockRenderVerdict('<div data-wpj-render-block="1" data-wpj-registered="1"></div>', 'acme/hello').defect)
      .toMatch(/does not say whether acme\/hello is dynamic/);
  });
});

describe('signRenderDoor', () => {
  it('signs a shortcode door path an author wrote, over the DECODED payload the agent reads', () => {
    expect(signRenderDoor('/?wpj_render=%5Bwpj_fixture%5D', SECRET, NOW))
      .toBe(`/?wpj_render=%5Bwpj_fixture%5D&wpj_exp=1700000300&wpj_sig=${VECTOR}`);
  });

  it('signs a block door path', () => {
    expect(signRenderDoor('/?wpj_render_block=wpj-fixture/dynamic', SECRET, NOW))
      .toBe('/?wpj_render_block=wpj-fixture/dynamic&wpj_exp=1700000300&wpj_sig=63a9625886e81437539466a0bfdf44674d3861a584583aa505e4be0fdfe86ed2');
  });

  it('returns every other path unchanged', () => {
    for (const path of ['/', '/wp-admin/options-general.php', '/?p=1', '/?xwpj_render=1', '/sample-page/#wpj_render=1']) {
      expect(signRenderDoor(path, SECRET, NOW), path).toBe(path);
    }
  });

  it('keeps a fragment after the signature', () => {
    expect(signRenderDoor('/?wpj_render=%5Bwpj_fixture%5D#top', SECRET, NOW))
      .toBe(`/?wpj_render=%5Bwpj_fixture%5D&wpj_exp=1700000300&wpj_sig=${VECTOR}#top`);
  });

  it('replaces a stale signature rather than sending two', () => {
    const signed = signRenderDoor('/?wpj_render=%5Bwpj_fixture%5D&wpj_exp=1&wpj_sig=abc', SECRET, NOW);
    expect(signed.match(/wpj_sig=/g)).toHaveLength(1);
    expect(new URLSearchParams(signed.split('?')[1]).get('wpj_sig')).toBe(VECTOR);
    expect(new URLSearchParams(signed.split('?')[1]).get('wpj_exp')).toBe('1700000300');
  });

  it('refuses a path that opens both doors, which no single signature can cover', () => {
    expect(() => signRenderDoor('/?wpj_render=%5Ba%5D&wpj_render_block=a/b', SECRET, NOW)).toThrow(/both render doors/);
  });
});
