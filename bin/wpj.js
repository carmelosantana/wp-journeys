#!/usr/bin/env node
/**
 * The `wpj` entry point.
 *
 * Node 22.18+ runs the TypeScript below it natively, with no loader and no build step. This file
 * stays plain JavaScript so the shebang line is the only thing between the shell and the CLI.
 *
 * Exiting lives here rather than in `src/runner/cli.ts`, which keeps that module importable —
 * and therefore testable — without ending the process that imports it.
 */
import { SECRET_VAR } from '../src/config.ts';
import { outboundText } from '../src/outbound.ts';
import { main } from '../src/runner/cli.ts';

main().then(
  (code) => {
    process.exit(code);
  },
  (error) => {
    // A failure before any journey ran: bad config, an unreachable agent, a baseline that could
    // not be captured. It is a failed run, not a clean one.
    // Neither the secret nor a login token reaches stderr, even if a message quotes one (R95e).
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${outboundText(message, process.env[SECRET_VAR])}\n`);
    process.exit(1);
  },
);
