/**
 * The one lifecycle helper every journey uses: an isolated context, the sentinel armed BEFORE
 * the first navigation, the actor authenticated (unless anonymous), the body run, and the
 * result packaged.
 *
 * The anonymous asymmetry is handled here, once. No journey may branch on it.
 *
 * It also owns the sentinel (R44). `drain()` reports findings cumulative for a sentinel's
 * lifetime and de-duplicates that whole list on status + url, so a sentinel shared between two
 * journeys drops the second one's genuine 5xx on a URL the first already reported — a false
 * green. Taking no sentinel parameter is what makes that impossible rather than merely
 * discouraged.
 *
 * Nothing here is allowed to turn a lost signal into a clean run: a body that throws, a login
 * that fails, a sentinel that cannot be installed or drained each become a finding, and a
 * finding is a failure.
 */
import type { Browser, Page } from '@playwright/test';

import { isAnonymous, type Actor } from '../actors/roles.ts';
import type { AgentClient } from '../agent/client.ts';
import type { Config } from '../config.ts';
import type { Finding } from '../sentinel/phplog.ts';
import { installSentinel, type Sentinel } from '../sentinel/sentinel.ts';
import type { JourneyResult, SurfaceAxis } from './index.ts';

/** What a journey actually does, returning how many entities it created. */
export type JourneyBody = (page: Page, sentinel: Sentinel) => Promise<number>;

/** A thrown value's message, never empty — an empty finding text reads as nothing at all. */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.trim() === '' ? `a value with no message was thrown (${typeof error})` : text;
}

/** A journey's own check that failed, as opposed to something the sentinel observed. */
function assertionFinding(text: string): Finding {
  return { kind: 'assertion', text };
}

/**
 * Authenticate the actor.
 *
 * The user id comes from `ensureActor` and nowhere else: the agent mints a login only for users
 * it created itself, so a hardcoded or real-site id is refused by design (R36).
 *
 * The minted URL is visited THROUGH the sentinel, so a broken login is a finding here rather
 * than an unexplained failure three steps later. The mint 302s into wp-admin, so the settled
 * status is 2xx; landing on wp-login.php instead is exactly what `classifyNavigation` reports.
 */
async function authenticate(
  page: Page, sentinel: Sentinel, agent: AgentClient, actor: Actor,
): Promise<void> {
  try {
    const { userId } = await agent.ensureActor(actor);
    const { url } = await agent.mintLogin(userId);
    await sentinel.visit(page, url);
  } catch (error) {
    // Named, because "HTTP 403 for mintLogin" in a summary does not say which step of which
    // journey could not run.
    throw new Error(`could not authenticate as ${actor}: ${messageOf(error)}`);
  }
}

/**
 * Collect the sentinel's findings, or say out loud that they could not be collected.
 *
 * A drain that throws (the agent went away mid-journey) would otherwise propagate and lose the
 * body's own findings with it — and an empty list here renders as ok.
 */
async function drainOrSaySo(sentinel: Sentinel): Promise<Finding[]> {
  try {
    return await sentinel.drain();
  } catch (error) {
    return [assertionFinding(
      `the sentinel could not be drained (${messageOf(error)}) — this journey's signals were NOT read`,
    )];
  }
}

export async function runAsActor(
  browser: Browser,
  cfg: Config,
  agent: AgentClient,
  name: string,
  actor: Actor,
  surface: SurfaceAxis,
  body: JourneyBody,
): Promise<JourneyResult> {
  // One context per journey: cookies, storage and the minted session belong to this actor only.
  const context = await browser.newContext({ baseURL: cfg.baseUrl, ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();

    let sentinel: Sentinel;
    try {
      sentinel = await installSentinel(page, agent);
    } catch (error) {
      // With no sentinel there are no signals at all, so the journey is not run: a body driven
      // with nothing watching it would report a clean pass no matter what it hit.
      return {
        name, actor, surface, entitiesCreated: 0,
        findings: [assertionFinding(
          `the sentinel could not be installed (${messageOf(error)}) — this journey was not run`,
        )],
      };
    }

    const thrown: Finding[] = [];
    let entitiesCreated = 0;
    try {
      if (!isAnonymous(actor)) await authenticate(page, sentinel, agent, actor);
      entitiesCreated = await body(page, sentinel);
    } catch (error) {
      // R3: a throw is this journey's failure, not the run's. Recorded, then the sentinel is
      // still drained and the context is still closed.
      thrown.push(assertionFinding(messageOf(error)));
    }

    return {
      name, actor, surface, entitiesCreated,
      // Observed first, then the journey's own verdict, which usually explains them.
      findings: [...await drainOrSaySo(sentinel), ...thrown],
    };
  } finally {
    await context.close();
  }
}
