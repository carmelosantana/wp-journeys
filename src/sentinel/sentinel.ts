/**
 * The sentinel: four live signals wired onto a Playwright page, plus the debug.log delta
 * drained from the agent.
 *
 * `drain()` is async because the log signal is a round trip. It is also where a LOST signal
 * becomes visible: if the agent reports the log unavailable, that is recorded as a finding,
 * never swallowed. A sentinel that quietly lost a signal is the false green this project
 * exists to prevent.
 */
import type { Page } from '@playwright/test';

import type { AgentClient } from '../agent/client.ts';
import {
  BENIGN_NETWORK, classifyConsole, classifyNavigation, classifyPhpLogLine, classifyRequestFailed,
  classifyResponse, scanBody, type Expectation, type Finding,
} from './classify.ts';

/**
 * One sentinel per journey — never share one across journeys.
 *
 * `drain()` reports everything seen since `installSentinel`, and de-duplicates across that
 * whole list. A sentinel shared by two journeys would therefore drop journey 2's genuine 5xx
 * on a URL journey 1 already reported, and journey 2 would read as clean. That is a false
 * green of exactly the kind this class exists to prevent, so install a fresh sentinel (on a
 * fresh page) for each journey rather than reusing one.
 */
export interface Sentinel {
  /**
   * Declare what the NEXT navigation expects (e.g. that this actor must be denied).
   *
   * One-shot (R40): `visit()` consumes the expectation and reverts to strict. A sticky
   * expectation is a silent pass — once a journey declared a denial for one screen, every
   * later screen would accept a 401/403/login redirect as satisfying a denial nobody asked
   * for, and a genuine permission regression would report nothing at all.
   */
  expect(expectation: Expectation): void;
  /**
   * Navigate and assert the MAIN DOCUMENT's status. Every journey uses this instead of
   * `page.goto` — a bare goto asserts nothing about the status, and a 502 error page reads
   * as perfectly good content. It also scans the body it landed on, so the scan covers the
   * whole journey rather than only the screen showing at `drain()` time.
   */
  visit(page: Page, url: string): Promise<void>;
  /** Collect everything observed so far, including the PHP log delta. */
  drain(): Promise<Finding[]>;
}

/**
 * What makes two findings the same defect, or `null` for kinds that never collide.
 *
 * `response`: one status on one URL, seen by both the listener and `visit()`.
 *
 * `bodyscan`: now that `visit()` and `drain()` both scan (R41), one screen that never changed
 * is scanned twice. Collapsing on the TEXT rather than the URL is what keeps that safe — the
 * text carries the severity, so a screen that later prints a WORSE diagnostic still reports it
 * as its own finding. A seen-URL guard would instead suppress that second, real defect, which
 * is the silent pass this whole class exists to prevent.
 */
function collapseKey(finding: Finding): string | null {
  // A space delimits unambiguously: the status is digits or empty, so it cannot run into
  // the URL.
  if (finding.kind === 'response') return `response ${finding.status ?? ''} ${finding.url ?? ''}`;
  if (finding.kind === 'bodyscan') return `bodyscan ${finding.text}`;
  return null;
}

/**
 * A 5xx main document is seen twice: once by the `response` listener and once by `visit()`.
 *
 * The navigation's verdict WINS (R42). Playwright emits `response` as soon as status and
 * headers arrive, necessarily before `goto()` resolves, so a plain keep-the-first always kept
 * the subresource wording and always discarded the document verdict — "navigation to <url>
 * returned HTTP 502 — the journey required a document it could act on", and the richer
 * expected-denial text. Membership of `fromNavigation` is the tag; a bare last-wins would
 * instead be decided by arrival order, which is not the thing that matters.
 */
function dedupe(findings: Finding[], fromNavigation: WeakSet<Finding>): Finding[] {
  const winners = new Map<string, Finding>();
  for (const finding of findings) {
    const key = collapseKey(finding);
    if (key === null) continue;
    const held = winners.get(key);
    if (!held) {
      winners.set(key, finding);
      continue;
    }
    if (!fromNavigation.has(held) && fromNavigation.has(finding)) winners.set(key, finding);
  }
  return findings.filter((finding) => {
    const key = collapseKey(finding);
    return key === null || winners.get(key) === finding;
  });
}

export async function installSentinel(page: Page, agent: AgentClient): Promise<Sentinel> {
  const findings: Finding[] = [];

  /** Findings produced by `visit()`'s own assertion, which outrank the listener's echo. */
  const fromNavigation = new WeakSet<Finding>();

  const STRICT: Expectation = { denyExpected: false };
  let declared: Expectation = STRICT;

  /** Read the declared expectation and revert to strict: it applies to ONE navigation (R40). */
  function consumeExpectation(): Expectation {
    const current = declared;
    declared = STRICT;
    return current;
  }

  /**
   * Listener work that needs a round trip. Playwright does not await its listeners, so these
   * are still in flight when a journey calls `drain()`, and `drain()` waits for them.
   */
  const pending: Array<Promise<void>> = [];

  /** Let every in-flight listener finish, so its finding is on the list before we act on it. */
  async function settle(): Promise<void> {
    // A handler may queue another while we wait, so keep going until nothing is left.
    while (pending.length > 0) await Promise.all(pending.splice(0));
  }

  /**
   * The byte offset the next log read starts from, or `null` when there is no usable one —
   * which is what a lost read leaves behind, because a lost read's `offset` only echoes the
   * one it was sent.
   */
  let offset: number | null = null;
  let lostReason = 'no reason given';

  /**
   * Take a size-only baseline (R33). Never `logDelta(0)`: that pulls the whole debug.log back
   * over HTTP purely to learn its length, which on a long-lived dev site is megabytes.
   *
   * Note that this call is itself a WordPress request served with the plugin under test
   * active, so a notice the plugin emits on EVERY request is written around the read and lands
   * in the next window. Absorbing that per-request noise is the run baseline's job, not a
   * single visit's.
   */
  async function rebaseline(): Promise<void> {
    const fresh = await agent.logDelta('end');
    offset = fresh.available ? fresh.offset : null;
    if (!fresh.available) lostReason = fresh.reason ?? 'no reason given';
  }

  function lostLog(reason: string): Finding {
    return {
      kind: 'phplog',
      text: `debug.log signal unavailable (${reason}) — PHP diagnostics in this window were NOT read`,
    };
  }

  /**
   * Read the window's log lines, or say out loud that the window could not be read. There is
   * no third outcome: an unread window must never return the empty list a clean one returns.
   */
  async function readLog(): Promise<void> {
    if (offset === null) {
      findings.push(lostLog(lostReason));
      await rebaseline();
      return;
    }
    const delta = await agent.logDelta(offset);
    if (!delta.available) {
      lostReason = delta.reason ?? 'no reason given';
      findings.push(lostLog(lostReason));
      // Its offset is only the one we sent, echoed. Feeding that forward would re-read an old
      // window and attribute its contents to the wrong visit, so start a fresh baseline.
      await rebaseline();
      return;
    }
    offset = delta.offset;
    for (const line of delta.lines) {
      const finding = classifyPhpLogLine(line);
      if (finding) findings.push(finding);
    }
  }

  /** The page's URL, which is itself unreadable once the page has closed. */
  function currentUrl(): string | undefined {
    try {
      return page.url();
    } catch {
      return undefined;
    }
  }

  /**
   * Scan whatever the page is showing now.
   *
   * Called from `visit()` for each screen AND from `drain()` for the final state (R41). The
   * body scan is the FALLBACK for the case where the log signal is lost, so scanning only the
   * screen that happened to be showing at drain time would silently exclude most of a journey
   * from the one signal left.
   */
  async function scanCurrentBody(): Promise<void> {
    let html: string;
    try {
      html = await page.content();
    } catch (error) {
      // A body that cannot be read is a lost signal, not a clean one — and losing it must not
      // cost the log signal too, so this is recorded and the caller carries on.
      findings.push({
        kind: 'bodyscan', url: currentUrl(),
        text: `the page body could not be read to scan it (${String(error)}) — a PHP diagnostic printed into the response would go unseen`,
      });
      return;
    }
    const finding = scanBody(html, currentUrl() ?? '');
    if (finding) findings.push(finding);
  }

  // Attach the live listeners BEFORE the baseline's round trip: anything already in flight
  // would otherwise slip through that await observed by nobody.
  page.on('response', (response) => {
    const finding = classifyResponse(response.status(), response.url());
    if (finding) findings.push(finding);
  });

  page.on('console', (message) => {
    const finding = classifyConsole(message.type(), message.text(), message.location()?.url);
    if (finding) findings.push(finding);
  });

  page.on('requestfailed', (request) => {
    // `request.response()` returns a PROMISE, so `request.response() !== null` is always true:
    // every failed request would look like a benign body-drain abort and this signal would be
    // off while still appearing wired up. TypeScript does not catch that comparison either.
    // Awaiting is what makes it real, and what puts the work on `pending`.
    const inspect = async (): Promise<void> => {
      const response = await request.response();
      const finding = classifyRequestFailed(
        request.url(), request.failure()?.errorText ?? '', response !== null,
      );
      if (finding) findings.push(finding);
    };
    pending.push(inspect().catch((error: unknown) => {
      findings.push({
        kind: 'requestfailed', url: request.url(),
        text: `a failed request for ${request.url()} could not be classified (${String(error)}) — treat this signal as lost, not clean`,
      });
    }));
  });

  // Read the log offset before anything navigates, so the delta is this run's.
  await rebaseline();

  return {
    expect(next: Expectation) {
      declared = next;
    },

    /**
     * Retries ONCE on a benign network fault, then asserts the document's status and scans
     * the body it landed on.
     *
     * Navigation is retried because this runner provokes `ERR_NETWORK_CHANGED` itself by
     * running wp-cli mid-run. INPUT is never retried anywhere in this codebase: a retried
     * click double-submits, which is a data bug wearing a flake's clothes.
     */
    async visit(target: Page, url: string): Promise<void> {
      if (target !== page) {
        throw new Error(
          'sentinel.visit() was given a page other than the one the sentinel was installed on — '
            + 'its response, console and requestfailed listeners are not attached to that page, so '
            + 'three of the four signals would be silently missing.',
        );
      }
      // Consumed before the navigation can throw, so a failed visit cannot leak its
      // expectation onto the next one (R40).
      const expectation = consumeExpectation();
      const mark = findings.length;

      let response;
      try {
        response = await page.goto(url);
      } catch (error) {
        if (!BENIGN_NETWORK.test(String(error))) throw error;
        // Discard everything the abandoned attempt observed (R43). Dedupe would absorb its
        // duplicated 5xx, but nothing absorbs its console noise, and that noise would fail a
        // journey that is actually fine. Settle first, so late-arriving findings from that
        // attempt land inside the truncated region rather than after it.
        await settle();
        findings.length = mark;
        response = await page.goto(url);
      }

      if (!response) {
        // Playwright returns null when the navigation produced no response at all. Asserting
        // nothing here would let the journey continue against an unknown document.
        findings.push({
          kind: 'response', url,
          text: `navigation to ${url} produced no response to assert — the document's status could not be read`,
        });
        // No document arrived, so there is nothing to settle or scan: waiting for networkidle
        // would only burn the full Playwright timeout before failing.
        return;
      }

      // The FINAL url, not the requested one: WordPress denies a logged-out actor by
      // redirecting to wp-login.php, and the requested URL cannot show that.
      const finding = classifyNavigation(response.status(), response.url(), expectation);
      if (finding) {
        findings.push(finding);
        fromNavigation.add(finding);
      }
      await page.waitForLoadState('networkidle');
      await scanCurrentBody();
    },

    async drain(): Promise<Finding[]> {
      // Settle the listeners that are mid-round-trip. Returning without waiting would drop
      // their findings and report the window as clean.
      await settle();
      await scanCurrentBody();
      await readLog();
      return dedupe(findings, fromNavigation);
    },
  };
}
