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
  classifyConsole, classifyNavigation, classifyPhpLogLine, classifyRequestFailed,
  classifyResponse, scanBody, type Expectation, type Finding,
} from './classify.ts';

/** A network fault worth one retry — the machine's network moved, the app did not break. */
const RETRYABLE = /net::(ERR_NETWORK_CHANGED|ERR_NETWORK_IO_SUSPENDED|ERR_INTERNET_DISCONNECTED)/;

export interface Sentinel {
  /** Declare what the next navigations expect (e.g. that this actor must be denied). */
  expect(expectation: Expectation): void;
  /**
   * Navigate and assert the MAIN DOCUMENT's status. Every journey uses this instead of
   * `page.goto` — a bare goto asserts nothing about the status, and a 502 error page reads
   * as perfectly good content.
   */
  visit(page: Page, url: string): Promise<void>;
  /** Collect everything observed so far, including the PHP log delta. */
  drain(): Promise<Finding[]>;
}

/**
 * A 5xx main document is seen twice: once by the `response` listener and once by `visit()`
 * (R1). Both say the same thing about the same URL, so keep the first and drop the echo.
 * Only `response` findings collide this way; every other kind is left alone.
 */
function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    if (finding.kind !== 'response') return true;
    // A space delimits unambiguously: the status is digits or empty, so it cannot run into
    // the URL.
    const key = `${finding.status ?? ''} ${finding.url ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function installSentinel(page: Page, agent: AgentClient): Promise<Sentinel> {
  const findings: Finding[] = [];
  let expectation: Expectation = { denyExpected: false };

  /**
   * Listener work that needs a round trip. Playwright does not await its listeners, so these
   * are still in flight when a journey calls `drain()`, and `drain()` waits for them.
   */
  const pending: Array<Promise<void>> = [];

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
      expectation = next;
    },

    /**
     * Retries ONCE on a benign network fault, then asserts the document's status.
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
      let response;
      try {
        response = await page.goto(url);
      } catch (error) {
        if (!RETRYABLE.test(String(error))) throw error;
        response = await page.goto(url);
      }
      if (response) {
        // The FINAL url, not the requested one (R1): WordPress denies a logged-out actor by
        // redirecting to wp-login.php, and the requested URL cannot show that.
        const finding = classifyNavigation(response.status(), response.url(), expectation);
        if (finding) findings.push(finding);
      } else {
        // Playwright returns null when the navigation produced no response at all. Asserting
        // nothing here would let the journey continue against an unknown document.
        findings.push({
          kind: 'response', url,
          text: `navigation to ${url} produced no response to assert — the document's status could not be read`,
        });
      }
      await page.waitForLoadState('networkidle');
    },

    async drain(): Promise<Finding[]> {
      // Settle the listeners that are mid-round-trip. Returning without waiting would drop
      // their findings and report the window as clean. A handler may queue another while we
      // wait, so keep going until nothing is left.
      while (pending.length > 0) await Promise.all(pending.splice(0));

      try {
        const bodyFinding = scanBody(await page.content(), page.url());
        if (bodyFinding) findings.push(bodyFinding);
      } catch (error) {
        // A body that cannot be read is a lost signal, not a clean one — and losing it must
        // not cost the log signal too, so this is recorded and the drain carries on.
        findings.push({
          kind: 'bodyscan', url: currentUrl(),
          text: `the page body could not be read to scan it (${String(error)}) — a PHP diagnostic printed into the response would go unseen`,
        });
      }

      await readLog();
      return dedupe(findings);
    },
  };
}
