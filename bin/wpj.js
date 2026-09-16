#!/usr/bin/env node
/**
 * The `wpj` entry point.
 *
 * Node 22 runs the TypeScript below it natively, with no loader and no build step. This file
 * stays plain JavaScript so the shebang line is the only thing between the shell and the CLI.
 *
 * Exiting lives here rather than in `src/runner/cli.ts`, which keeps that module importable —
 * and therefore testable — without ending the process that imports it.
 */
import { main } from '../src/runner/cli.ts';

main().then(
  (code) => {
    process.exit(code);
  },
  (error) => {
    // A failure before any journey ran: bad config, an unreachable agent, a baseline that could
    // not be captured. It is a failed run, not a clean one.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
