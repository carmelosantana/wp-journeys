/**
 * The simplest complete journey, and the proof the whole stack is wired: an anonymous visitor
 * loads the front page, and nothing anywhere reports a problem.
 *
 * It is deliberately anonymous — that exercises the one actor with no login, which is the path
 * most likely to be broken by a lifecycle helper that assumes one.
 */
import { Actor } from '../actors/roles.ts';
import { runAsActor } from '../journeys/support.ts';
import type { Journey } from '../journeys/index.ts';

export const frontendRenders: Journey = {
  name: 'frontend-renders',
  actor: Actor.ANONYMOUS,
  surface: 'frontend',
  run: (browser, cfg, agent) =>
    runAsActor(browser, cfg, agent, 'frontend-renders', Actor.ANONYMOUS, 'frontend', async (page, sentinel) => {
      // sentinel.visit, never page.goto: this is what asserts the document was actually 2xx.
      await sentinel.visit(page, '/');
      return 0;
    }),
};
