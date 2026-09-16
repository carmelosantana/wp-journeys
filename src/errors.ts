import { MIN_SECRET_LENGTH } from './config.ts';

/**
 * One way to read a thrown value's message.
 *
 * Three modules need it — the lifecycle helper turning a throw into a finding, the baseline
 * combining two failures, and (from Task 12) the CLI printing one — and three copies would
 * drift. The empty case matters: an empty finding text renders as nothing at all, which is the
 * silent pass this project exists to prevent.
 */
export function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.trim() === '' ? `a value with no message was thrown (${typeof error})` : text;
}

/**
 * Remove the shared secret from text on its way out of the process — a tool result, a stderr
 * line. Nothing the runner writes quotes it; this makes that a guarantee rather than a property
 * of today's messages (R89).
 *
 * Only a secret `loadConfig` would accept is scrubbed. A shorter value is refused before it is
 * ever sent anywhere, and scrubbing, say, `x` would shred every message instead.
 */
export function redactSecret(text: string, secret: string | undefined): string {
  if (secret === undefined || secret.length < MIN_SECRET_LENGTH) return text;
  return text.split(secret).join('<REDACTED>');
}
