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
import { messageOf } from '../errors.ts';
import { redactLoginToken } from '../sentinel/classify.ts';
import type { Finding } from '../sentinel/phplog.ts';
import { installSentinel, type Sentinel } from '../sentinel/sentinel.ts';
import type { JourneyResult, SurfaceAxis } from './index.ts';

/**
 * What a journey actually does, returning how many entities it created. `note` records a line
 * the summary prints under the row whatever its outcome.
 */
export type JourneyBody = (page: Page, sentinel: Sentinel, note: (text: string) => void) => Promise<number>;

/**
 * A screen every logged-in role can reach, and no logged-out visitor can (R54, R67).
 *
 * `profile.php` needs only `read`, which subscriber upwards all hold, and WordPress bounces an
 * anonymous request for it to wp-login.php. Every denial a journey expects is ALSO satisfied
 * by that bounce, so a journey whose session was never established runs as an anonymous
 * visitor and passes having proved nothing. `authenticate` below catches a mint that bounces
 * to login or never leaves the token URL, but not one that redirects away to an ordinary 200
 * page without a session. One screen asserted as ALLOWED, which only a real session can
 * reach, is what makes that impossible: a secretly-anonymous journey fails on its first step.
 */
export const CONTROL_SCREEN = '/wp-admin/profile.php';

/** A journey's own check that failed, as opposed to something the sentinel observed. */
function assertionFinding(text: string): Finding {
  return { kind: 'assertion', text };
}

/** The page's URL, which is itself unreadable once the page has closed. */
function currentUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return '<the page could not be asked where it was>';
  }
}

/**
 * A settled URL still carrying the mint's token, which is what a REFUSED token leaves behind.
 *
 * Spending a token always redirects away from it, so this is decided without any assumption
 * about where a real session ought to end up — which is the whole point: the landing check R52
 * removed was wrong precisely because it made one.
 */
function stillHoldingToken(url: string): boolean {
  return /[?&]wpj_login=/i.test(url);
}

/**
 * Authenticate the actor.
 *
 * The user id comes from `ensureActor` and nowhere else: the agent mints a login only for users
 * it created itself, so a hardcoded or real-site id is refused by design (R36).
 *
 * The minted URL is visited THROUGH the sentinel, so a broken login is a finding here rather
 * than an unexplained failure three steps later.
 *
 * The navigation's VERDICT is then checked, because `sentinel.visit` RECORDS a bad login and
 * returns normally — it does not throw (R50). Without this check the body would run as an
 * ANONYMOUS visitor under the named actor's label: today that is a false RESULT rather than a
 * false green, but for a denial journey an unauthenticated body satisfies an expected denial
 * for entirely the wrong reason.
 *
 * The verdict is the test, NOT where the page came to rest (R52). Both ways a mint fails show
 * up as a finding on that navigation — the bounce to wp-login.php through `classifyNavigation`'s
 * login branch, and a 5xx on the mint itself through its status branch. Asserting the landing
 * was inside `/wp-admin/` instead would fail a session that is perfectly real: WooCommerce's
 * `wc_prevent_admin_access` redirects a subscriber to My Account, and hiding the dashboard from
 * non-admins is a common pattern. That is a false red precisely on the low-privilege actors
 * whose denials this suite exists to assert.
 */
async function authenticate(
  page: Page, sentinel: Sentinel, agent: AgentClient, actor: Actor,
): Promise<void> {
  try {
    const { userId } = await agent.ensureActor(actor);
    const { url } = await agent.mintLogin(userId);
    const verdict = await sentinel.visit(page, url);
    if (verdict.length > 0) {
      throw new Error(
        // The verdict's own text, which `classifyNavigation` already redacted (R51) — the
        // landing may still BE the token URL.
        `no session was established: ${verdict.map((finding) => finding.text).join('; ')}`,
      );
    }
    // R54: a refused token used to be SILENT, and silence here is the worst failure this runner
    // has. WordPress renders the ordinary home page AT the token URL with HTTP 200 — not a login
    // page, not a 5xx, so the verdict above is empty and this reads as a success. The body then
    // sweeps as an ANONYMOUS visitor, and for every role below administrator each screen expects
    // a denial, which a logged-out visitor satisfies through the login redirect. Four of the six
    // sweeps would report `pass` having asserted nothing at all.
    //
    // The agent now wp_die()s on a refused token, which the verdict catches. This stays because
    // the runner must not depend on the agent version it happens to be talking to, and because
    // the cost of being wrong here is a green run that proved nothing.
    const landed = currentUrl(page);
    if (stillHoldingToken(landed)) {
      throw new Error(
        `the minted token was refused — the page never left ${redactLoginToken(landed)}`,
      );
    }
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
    const notes: string[] = [];
    let entitiesCreated = 0;
    try {
      if (!isAnonymous(actor)) await authenticate(page, sentinel, agent, actor);
      entitiesCreated = await body(page, sentinel, (text) => { notes.push(text); });
    } catch (error) {
      // R3: a throw is this journey's failure, not the run's. Recorded, then the sentinel is
      // still drained and the context is still closed.
      thrown.push(assertionFinding(messageOf(error)));
    }

    const result: JourneyResult = {
      name, actor, surface, entitiesCreated,
      // Observed first, then the journey's own verdict, which usually explains them.
      findings: [...await drainOrSaySo(sentinel), ...thrown],
    };
    if (notes.length > 0) result.notes = notes;
    return result;
  } finally {
    await context.close();
  }
}
