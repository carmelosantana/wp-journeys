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
