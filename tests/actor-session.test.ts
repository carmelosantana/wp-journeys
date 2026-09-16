/**
 * The session primitive `runAsActor` is built on, and the MCP server's `login_as` holds open
 * (R84). Exercised against the REAL sentinel, like `runAsActor` itself: only the browser and the
 * agent are faked.
 *
 * `tests/journey-support.test.ts` is deliberately left untouched — its staying green is the proof
 * that extracting this primitive preserved `runAsActor`'s behaviour.
 */
import { describe, expect, it } from 'vitest';

import { Actor } from '../src/actors/roles.ts';
import { openActorSession } from '../src/journeys/support.ts';
import { CFG, CLEAN, FakeBrowser, FakePage, fakeAgent, landsOn, response } from './helpers/fakes.ts';

describe('openActorSession', () => {
  it('opens an anonymous session with no provisioning, no login and no navigation', async () => {
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    const { agent, calls } = fakeAgent();

    const opened = await openActorSession(browser.asBrowser(), CFG, agent, Actor.ANONYMOUS);

    expect(opened.ok).toBe(true);
    expect(page.gotos).toEqual([]);
    expect(calls.filter((c) => c.startsWith('ensureActor') || c.startsWith('mintLogin'))).toEqual([]);
    // Open until the caller closes it: this is what lets a session outlive one call.
    expect(browser.closed).toEqual([false]);
    expect(browser.options).toEqual([{ baseURL: CFG.baseUrl, ignoreHTTPSErrors: true }]);
  });

  it('authenticates a user-backed actor through the sentinel, and leaves the session open', async () => {
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    const { agent, calls } = fakeAgent({ ensureActor: async () => ({ userId: 9 }) });
    page.navigations = [landsOn('https://s.test/wp-admin/')];

    const opened = await openActorSession(browser.asBrowser(), CFG, agent, Actor.SUBSCRIBER);

    expect(opened.ok).toBe(true);
    expect(calls).toContain('ensureActor("subscriber")');
    expect(calls).toContain('mintLogin(9)');
    expect(page.gotos).toEqual(['https://s.test/?wpj_login=TOKEN']);
    expect(browser.closed).toEqual([false]);
  });

  it('hands back a page and sentinel the caller can keep driving, then drains and closes', async () => {
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    const { agent } = fakeAgent();
    page.navigations = [() => response(502, 'https://s.test/wp-admin/')];

    const opened = await openActorSession(browser.asBrowser(), CFG, agent, Actor.ANONYMOUS);
    if (!opened.ok) throw new Error('expected a session');
    const { session } = opened;
    expect(session.actor).toBe(Actor.ANONYMOUS);

    const verdict = await session.sentinel.visit(session.page, '/wp-admin/');
    expect(verdict).toMatchObject([{ kind: 'response', status: 502 }]);
    expect(await session.drain()).toMatchObject([{ kind: 'response', status: 502 }]);

    await session.close();
    expect(browser.closed).toEqual([true]);
  });

  it('refuses a session whose login failed, with the sentinel\'s findings first, and closes it', async () => {
    // R50: an unauthenticated page under an actor's label is worse than no page at all.
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    const { agent } = fakeAgent();
    page.navigations = [() => response(200, 'https://s.test/wp-login.php?redirect_to=%2Fwp-admin%2F')];

    const opened = await openActorSession(browser.asBrowser(), CFG, agent, Actor.EDITOR);

    expect(opened.ok).toBe(false);
    expect(!opened.ok && opened.findings).toMatchObject([
      { kind: 'response', text: expect.stringContaining('the actor is not authenticated') },
      { kind: 'assertion', text: expect.stringContaining('could not authenticate as editor') },
    ]);
    expect(browser.closed).toEqual([true]);
  });

  it('refuses a session whose token was refused in place (R54), never naming the token', async () => {
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    const { agent } = fakeAgent();
    page.navigations = [landsOn('https://s.test/?wpj_login=TOKEN')];

    const opened = await openActorSession(browser.asBrowser(), CFG, agent, Actor.AUTHOR);

    expect(opened.ok).toBe(false);
    const text = JSON.stringify(!opened.ok && opened.findings);
    expect(text).toContain('the minted token was refused');
    expect(text).not.toContain('TOKEN');
    expect(browser.closed).toEqual([true]);
  });

  it('refuses a session with no sentinel: no unwatched page is ever handed back', async () => {
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    const { agent, calls } = fakeAgent({
      logDelta: async () => { throw new Error('agent unreachable'); },
    });

    const opened = await openActorSession(browser.asBrowser(), CFG, agent, Actor.EDITOR);

    expect(opened.ok).toBe(false);
    expect(!opened.ok && opened.findings).toMatchObject([
      { kind: 'assertion', text: expect.stringMatching(/sentinel could not be installed.*agent unreachable.*nothing was run/) },
    ]);
    // Said the same way for a login_as session as for a journey (M8).
    expect(JSON.stringify(!opened.ok && opened.findings)).not.toMatch(/journey/);
    // Nothing is authenticated for a page nobody is watching.
    expect(calls.filter((c) => c.startsWith('mintLogin'))).toEqual([]);
    expect(browser.closed).toEqual([true]);
  });

  it('keeps a failed login\'s findings when closing its context ALSO fails, and says so (C1)', async () => {
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    browser.contextCloseError = new Error('context already gone');
    const { agent } = fakeAgent();
    page.navigations = [() => response(200, 'https://s.test/wp-login.php')];

    const opened = await openActorSession(browser.asBrowser(), CFG, agent, Actor.EDITOR);

    expect(opened.ok).toBe(false);
    expect(!opened.ok && opened.findings).toMatchObject([
      { kind: 'response', text: expect.stringContaining('the actor is not authenticated') },
      { kind: 'assertion', text: expect.stringContaining('could not authenticate as editor') },
      { kind: 'assertion', text: expect.stringContaining('context already gone') },
    ]);
  });

  it('keeps the sentinel failure when closing its context also fails (C1)', async () => {
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    browser.contextCloseError = new Error('context already gone');
    const { agent } = fakeAgent({ logDelta: async () => { throw new Error('agent unreachable'); } });

    const opened = await openActorSession(browser.asBrowser(), CFG, agent, Actor.ANONYMOUS);

    expect(!opened.ok && opened.findings).toMatchObject([
      { kind: 'assertion', text: expect.stringContaining('agent unreachable') },
      { kind: 'assertion', text: expect.stringContaining('context already gone') },
    ]);
  });

  it('closes the context and rethrows when the browser cannot give it a page (R95b)', async () => {
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    browser.newPageError = new Error('Target page, context or browser has been closed');
    const { agent, calls } = fakeAgent();

    await expect(openActorSession(browser.asBrowser(), CFG, agent, Actor.EDITOR))
      .rejects.toThrow(/^Target page, context or browser has been closed$/);

    expect(browser.closed).toEqual([true]);
    expect(calls).toEqual([]);
  });

  it('names both errors when that context will not close either (R95b)', async () => {
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    browser.newPageError = new Error('no page for you');
    browser.contextCloseError = new Error('context already gone');
    const { agent } = fakeAgent();

    await expect(openActorSession(browser.asBrowser(), CFG, agent, Actor.EDITOR))
      .rejects.toThrow(/no page for you[\s\S]*could not be closed: context already gone/);
    expect(browser.closed).toEqual([true]);
  });

  it('says out loud when a session could not be drained, rather than reading as clean', async () => {
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    let first = true;
    const { agent } = fakeAgent({
      logDelta: async () => {
        if (first) { first = false; return CLEAN; }
        throw new Error('agent unreachable');
      },
    });

    const opened = await openActorSession(browser.asBrowser(), CFG, agent, Actor.ANONYMOUS);
    if (!opened.ok) throw new Error('expected a session');

    const drained = await opened.session.drain();
    expect(drained).toMatchObject([
      { kind: 'assertion', text: expect.stringMatching(/could not be drained.*these signals were NOT read/) },
    ]);
    // Said the same way for a login_as session as for a journey (M8).
    expect(JSON.stringify(drained)).not.toMatch(/journey/);
    await opened.session.close();
  });
});
