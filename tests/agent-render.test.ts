import { describe, expect, it } from 'vitest';

import { blockRenderVerdict, blockRenderUrl, shortcodeRenderDefect, shortcodeRenderUrl } from '../src/agent/render.ts';

/** The agent's marker as Chromium serialises it, around what do_shortcode() returned. */
const rendered = (expanded: '0' | '1', inner: string) =>
  `<html><head></head><body><div data-wpj-render="1" data-wpj-expanded="${expanded}">${inner}</div></body></html>`;

describe('shortcodeRenderUrl', () => {
  it('asks the render door for exactly one bare tag', () => {
    expect(shortcodeRenderUrl('acme')).toBe('/?wpj_render=%5Bacme%5D');
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
    expect(blockRenderUrl('acme/hello')).toBe('/?wpj_render_block=acme%2Fhello');
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
