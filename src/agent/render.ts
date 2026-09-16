/**
 * The agent's render door, as the runner drives it: `?wpj_render=[tag]` expands one shortcode
 * on the front end and prints it inside a marker. Pure, and shared by every journey that
 * renders a shortcode — the discovered-surface suite and the manifest interpreter — so both
 * are held to one proof and neither depends on the other.
 */

/** The frontend URL that renders `[tag]` through the agent's render endpoint. */
export function shortcodeRenderUrl(tag: string): string {
  return `/?wpj_render=${encodeURIComponent(`[${tag}]`)}`;
}

/**
 * Why a render of `[tag]` proved nothing, or `null` when it expanded.
 *
 * The render itself is not the assertion (R5). If the agent's guard refused, `?wpj_render=`
 * serves the ordinary home page with a perfectly good 200 and the journey would pass having
 * rendered nothing at all. So each tag is proven twice over:
 *  - `[data-wpj-render]` is present, which only the agent's endpoint emits — the proof it ran;
 *  - the literal `[tag]` is gone, which is the proof the shortcode EXPANDED. WordPress returns
 *    an unregistered shortcode verbatim, so a tag that never registered reads as its own text.
 */
export function shortcodeRenderDefect(html: string, tag: string): string | null {
  if (!html.includes('data-wpj-render')) {
    return `rendering [${tag}] produced no wp-journeys render marker — the agent's render `
      + 'endpoint did not run, so nothing about this shortcode was actually asserted';
  }
  if (html.includes(`[${tag}]`)) {
    return `the shortcode [${tag}] came back verbatim — WordPress returns an unregistered `
      + 'shortcode unchanged, so it never expanded';
  }
  return null;
}
