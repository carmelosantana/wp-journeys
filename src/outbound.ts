/**
 * The ONE filter for text leaving the process: the CLI's stdout and stderr, the MCP server's tool
 * results, and the entry point's crash line.
 *
 * Findings are redacted where they are BUILT, and this is the backstop for everything else — a
 * journey that threw, a module's own message, a future signal that forgot. The shared secret is
 * removed outright (R89) and a login token is redacted in every spelling (R51, R87).
 */
import { redactSecret } from './errors.ts';
import { redactLoginToken } from './sentinel/redact.ts';

export function outboundText(text: string, secret: string | undefined): string {
  return redactLoginToken(redactSecret(text, secret));
}
