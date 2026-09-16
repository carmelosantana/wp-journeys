import { describe, expect, it } from 'vitest';

import { shortcodeRenderDefect, shortcodeRenderUrl } from '../src/agent/render.ts';

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
