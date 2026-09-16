/**
 * Login-token redaction, in its own module so every signal — the log classifier included, which
 * `classify.ts` itself imports — can use the one definition without an import cycle.
 */

/**
 * The login-token parameter's NAME, in every spelling a URL can carry it (R95c): plain, percent-
 * encoded (a login bounce carries the token URL inside `redirect_to`, where `?` `=` `&` arrive as
 * %3F %3D %26), encoded again (%253F…), or only half-encoded. The separator must come directly
 * before the name and `=` directly after, so `?page=wpj_login%3Dx` and `?xwpj_login=1` are not it.
 *
 * The ONE definition: the redactor and the live proof's leak check are both built from it.
 */
export const LOGIN_TOKEN_PARAM = /(?:[?&]|%(?:25)*3F|%(?:25)*26)wpj_login(?:=|%(?:25)*3D)/i;

/** The parameter and its value. The value ends at `&`, `#`, whitespace, or an encoded `&`. */
const TOKEN_WITH_VALUE = new RegExp(`(${LOGIN_TOKEN_PARAM.source})(?:(?!%(?:25)*26)[^&#\\s])*`, 'gi');

const UNREDACTED_TOKEN = new RegExp(`${LOGIN_TOKEN_PARAM.source}(?!<REDACTED>)`, 'i');

/**
 * Strip a minted login token out of anything that will be shown, stored or logged (R51).
 *
 * The runner authenticates an actor by navigating to `?wpj_login=<token>`, so that URL is what
 * a login-step finding gets built from — and findings flow into `JourneyResult`, the run
 * summary, a Playwright trace and whatever CI keeps. The token is single-use and expires in
 * five minutes, but a credential written into a log is a credential written into a log.
 *
 * Applied where findings are BUILT, not where they are printed: otherwise every consumer of a
 * finding would have to remember, and one of them would not.
 */
export function redactLoginToken(url: string): string {
  return url.replace(TOKEN_WITH_VALUE, '$1<REDACTED>');
}

/** Whether text still carries a login token that was not redacted, in any spelling. */
export function containsLoginToken(text: string): boolean {
  return UNREDACTED_TOKEN.test(text);
}
