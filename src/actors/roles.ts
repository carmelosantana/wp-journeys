/**
 * The closed set of actors the runner drives WordPress as.
 *
 * Five core WordPress roles plus `anonymous`. Anonymous is a first-class actor, not a
 * special case: it is the one every public visitor uses, and the frontend half of the
 * surface axis is meaningless without it. It carries one asymmetry — no login — which the
 * lifecycle helper handles explicitly rather than by threading a flag through call sites.
 */
export const Actor = {
  ANONYMOUS: 'anonymous',
  SUBSCRIBER: 'subscriber',
  CONTRIBUTOR: 'contributor',
  AUTHOR: 'author',
  EDITOR: 'editor',
  ADMINISTRATOR: 'administrator',
} as const;

export type Actor = (typeof Actor)[keyof typeof Actor];

/** Every actor, least-privileged first, so a sweep reads in escalating order. */
export const ALL_ACTORS: readonly Actor[] = Object.values(Actor);

export function isAnonymous(actor: Actor): boolean {
  return actor === Actor.ANONYMOUS;
}

/** The WordPress username the runner provisions for an actor. Anonymous has none. */
export function usernameFor(actor: Actor): string {
  return isAnonymous(actor) ? '' : `wpj_${actor}`;
}
