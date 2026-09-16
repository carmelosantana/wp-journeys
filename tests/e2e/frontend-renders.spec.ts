/**
 * The first journey against a real WordPress, plus the two proofs that it can go red.
 *
 * A green run that cannot go red proves nothing, so the navigation assertion and the
 * thrown-body path are exercised here as well — both of them silent failures if they regress.
 *
 * Needs a live target: `set -a; . ./.env; set +a` before `pnpm e2e`.
 */
import { chromium, expect, test } from '@playwright/test';

import { Actor } from '../../src/actors/roles.ts';
import { createAgentClient } from '../../src/agent/client.ts';
import { loadConfig } from '../../src/config.ts';
import { outcomeOf } from '../../src/journeys/index.ts';
import { runAsActor } from '../../src/journeys/support.ts';
import { frontendRenders } from '../../src/suite/frontend-renders.ts';

const cfg = loadConfig(process.env);
const agent = createAgentClient(cfg.baseUrl, cfg.secret);

/** The findings, pretty-printed, so a failure names the defect instead of a length mismatch. */
function detail(result: { findings: unknown[] }): string {
  return JSON.stringify(result.findings, null, 2);
}

test('an anonymous visitor loads the front page with no findings', async () => {
  const browser = await chromium.launch();
  try {
    const result = await frontendRenders.run(browser, cfg, agent);
    expect(result.findings, detail(result)).toEqual([]);
    expect(outcomeOf(result)).toBe('pass');
  } finally {
    await browser.close();
  }
});

test('a missing document fails on its STATUS, which nothing else in the browser surfaces', async () => {
  // A 404 (like a 502) renders a perfectly good-looking page: it screenshots fine and passes
  // every content assertion. Only `classifyNavigation` catches it, and only because
  // `sentinel.visit` asserts the main document's status rather than inferring it.
  const missing = `/wpj-definitely-missing-${Date.now()}/`;
  const browser = await chromium.launch();
  try {
    const result = await runAsActor(
      browser, cfg, agent, 'missing-document', Actor.ANONYMOUS, 'frontend',
      async (page, sentinel) => {
        await sentinel.visit(page, missing);
        return 0;
      },
    );

    expect(outcomeOf(result), detail(result)).toBe('fail');
    expect(result.findings, detail(result)).toContainEqual(
      expect.objectContaining({ kind: 'response', status: 404 }),
    );
  } finally {
    await browser.close();
  }
});

test('a journey whose body throws is recorded, not crashed on', async () => {
  // R3: one failing journey must never abort a run. The throw becomes an `assertion` finding,
  // the sentinel is still drained, and the context is still closed.
  const browser = await chromium.launch();
  try {
    const result = await runAsActor(
      browser, cfg, agent, 'throwing-body', Actor.ANONYMOUS, 'frontend',
      async (page, sentinel) => {
        await sentinel.visit(page, '/');
        throw new Error('the journey asserted something that was not true');
      },
    );

    expect(result.findings, detail(result)).toEqual([
      { kind: 'assertion', text: 'the journey asserted something that was not true' },
    ]);
    expect(outcomeOf(result)).toBe('fail');
  } finally {
    await browser.close();
  }
});
