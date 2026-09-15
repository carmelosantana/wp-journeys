/** Journey contracts. */
import type { Browser } from '@playwright/test';

import type { AgentClient } from '../agent/client.ts';
import type { Actor } from '../actors/roles.ts';
import type { Config } from '../config.ts';
import type { Finding } from '../sentinel/phplog.ts';

/**
 * Which half of WordPress a journey touches. This is an AXIS, not a family: a journey may
 * span both, and the crossing ones are the most valuable — a setting that saves in wp-admin
 * but never reaches the public site is invisible to either surface alone.
 */
export type SurfaceAxis = 'admin' | 'frontend' | 'both';

/** The outcome of one journey run. */
export interface JourneyResult {
  name: string;
  actor: Actor;
  surface: SurfaceAxis;
  /** How many entities the journey created; 0 for read-only paths. */
  entitiesCreated: number;
  /** Everything the sentinel observed. Empty is the only passing value. */
  findings: Finding[];
  /**
   * Set when the journey's gate said its subject is not present. A skip is a THIRD outcome:
   * the journey did nothing and asserted nothing, so it must never render as `ok`.
   */
  skipped?: boolean;
  skipReason?: string;
}

/** A named, actor-bound, surface-tagged scenario. */
export interface Journey {
  name: string;
  actor: Actor;
  surface: SurfaceAxis;
  run(browser: Browser, cfg: Config, agent: AgentClient): Promise<JourneyResult>;
}
