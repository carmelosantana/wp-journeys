/**
 * The browser and agent fakes a journey is driven against in unit tests.
 *
 * Only the browser and the agent are faked: the sentinel is what decides whether a journey is
 * clean, so a test that stubbed it would prove nothing about the thing being wired up. Shared
 * by the lifecycle helper's tests and the manifest interpreter's, which need the same page.
 */
import type { Browser, BrowserContext, Page } from '@playwright/test';

import type { AgentClient, LogDelta } from '../../src/agent/client.ts';
import type { Config } from '../../src/config.ts';

export const CFG: Config = { baseUrl: 'https://s.test/', secret: 'x'.repeat(16) };

export const CLEAN: LogDelta = { offset: 100, lines: [], available: true };

/** A response as the sentinel reads one: status and final URL, both synchronous. */
export function response(status: number, url: string): never {
  return { status: () => status, url: () => url } as never;
}

/** A navigation that settles on `url`: the mint 302s into wp-admin, so that is its landing. */
export function landsOn(url: string): () => never {
  return () => response(200, url);
}

/** The slice of Playwright's Page the sentinel and the helper touch. */
export class FakePage {
  readonly gotos: string[] = [];
  /** What each successive goto does; a 200 on the requested URL once the queue runs out. */
  navigations: Array<(url: string) => unknown> = [];
  body = '<html><body>ok</body></html>';
  /** The body's VISIBLE text, as `locator('body').innerText()` reads it — never the source. */
  text = 'ok';
  /** When set, `innerText()` rejects with it — a page that served no HTML body. */
  textError: Error | null = null;
  /** The options each `innerText()` call was given, so a test can see the timeout it asked for. */
  readonly innerTextCalls: Array<{ timeout?: number }> = [];
  /** Every `fill(selector, value)` the journey made, in order. */
  readonly fills: Array<[string, string]> = [];
  /** Every key the journey pressed, in order. */
  readonly keys: string[] = [];
  readonly keyboard = { press: async (key: string): Promise<void> => { this.keys.push(key); } };
  /** Every selector the journey clicked, in order. */
  readonly clicks: string[] = [];
  private readonly handlers: Record<string, Array<(arg: never) => unknown>> = {};

  on(event: string, handler: (arg: never) => unknown): void {
    (this.handlers[event] ??= []).push(handler);
  }

  emit(event: string, arg: unknown): void {
    for (const handler of this.handlers[event] ?? []) void handler(arg as never);
  }

  /** Where the page SETTLED, after redirects — how a login that failed becomes visible. */
  current = 'https://s.test/';

  async goto(url: string): Promise<unknown> {
    this.gotos.push(url);
    const step = this.navigations.shift();
    const landed = step ? step(url) : response(200, url);
    const settled = landed as { url?: () => string } | null;
    if (settled && typeof settled.url === 'function') this.current = settled.url();
    return landed;
  }

  url(): string {
    return this.current;
  }

  async content(): Promise<string> {
    return this.body;
  }

  async click(selector: string): Promise<void> {
    this.clicks.push(selector);
  }

  async fill(selector: string, value: string): Promise<void> {
    this.fills.push([selector, value]);
  }

  locator(_selector: string): { innerText: (options?: { timeout?: number }) => Promise<string> } {
    return {
      innerText: async (options = {}) => {
        this.innerTextCalls.push(options);
        if (this.textError) throw this.textError;
        return this.text;
      },
    };
  }

  async waitForLoadState(): Promise<void> {}

  asPage(): Page {
    return this as unknown as Page;
  }
}

/** A browser whose contexts hand out ONE page, so a test can drive it before the run starts. */
export class FakeBrowser {
  readonly options: unknown[] = [];
  readonly closed: boolean[] = [];

  constructor(readonly page: FakePage) {}

  /** When set, the next `newContext()` rejects with it (and clears it) — a crashed browser. */
  newContextError: Error | null = null;
  /** When set, the next context's `newPage()` rejects with it (and clears it). */
  newPageError: Error | null = null;
  /** When set, every context's `close()` rejects with it, after recording the close attempt. */
  contextCloseError: Error | null = null;
  private connected = true;
  private readonly disconnectHandlers: Array<() => void> = [];

  async newContext(options: unknown): Promise<BrowserContext> {
    if (this.newContextError) {
      const error = this.newContextError;
      this.newContextError = null;
      throw error;
    }
    this.options.push(options);
    const at = this.closed.push(false) - 1;
    const context = {
      newPage: async (): Promise<Page> => {
        if (this.newPageError) {
          const error = this.newPageError;
          this.newPageError = null;
          throw error;
        }
        return this.page.asPage();
      },
      close: async (): Promise<void> => {
        this.closed[at] = true;
        if (this.contextCloseError) throw this.contextCloseError;
      },
    };
    return context as unknown as BrowserContext;
  }

  isConnected(): boolean {
    return this.connected;
  }

  on(event: string, handler: () => void): void {
    if (event === 'disconnected') this.disconnectHandlers.push(handler);
  }

  /** The browser process went away, as Playwright reports it. */
  disconnect(): void {
    this.connected = false;
    for (const handler of this.disconnectHandlers) handler();
  }

  /** How many times the BROWSER itself was closed (contexts are tracked in `closed`). */
  browserClosed = 0;

  async close(): Promise<void> {
    this.browserClosed += 1;
  }

  asBrowser(): Browser {
    return this as unknown as Browser;
  }
}

/**
 * An agent that records what it was asked for. Any method a test did not arrange throws, so a
 * helper that calls something it should not — minting a login for the anonymous actor, say —
 * fails loudly instead of quietly working.
 */
export function fakeAgent(over: Partial<AgentClient> = {}) {
  const calls: string[] = [];
  const base: Partial<AgentClient> = {
    logDelta: async () => CLEAN,
    ensureActor: async () => ({ userId: 42 }),
    mintLogin: async () => ({ url: 'https://s.test/?wpj_login=TOKEN' }),
  };
  const arranged = { ...base, ...over } as Record<string, unknown>;
  const agent = new Proxy({}, {
    get(_target, property: string) {
      const method = arranged[property];
      if (typeof method !== 'function') {
        throw new Error(`runAsActor must not call agent.${property}()`);
      }
      return (...args: unknown[]) => {
        calls.push(`${property}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
        return (method as (...a: unknown[]) => unknown)(...args);
      };
    },
  }) as AgentClient;
  return { agent, calls };
}
