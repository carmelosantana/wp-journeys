<?php
/**
 * The render door's payload gate (R55).
 *
 * Pure: no WordPress functions, no I/O, so tests/php can assert it.
 *
 * Every other door the agent opens carries a credential — the REST and discovery doors the
 * shared secret, the login door a single-use token. The render door cannot: it is reached by a
 * browser navigation, which carries no header and has no token to spend. Its only protection is
 * the guard, so on a guarded development site ANY visitor who can reach the site can call it.
 *
 * And its output is echoed unescaped. Without this gate `?wpj_render=<script>…` is reflected
 * XSS, and `?wpj_render=[tag attr="…"]` runs any registered shortcode with attacker-chosen
 * attributes against the plugin under test. Dev-only is not the same as safe for everyone on
 * the LAN.
 *
 * So the gate is the exact shape the runner sends and nothing else: one bare shortcode tag.
 * src/suite/rendered-surface.ts sends `[tag]`, so this costs the journeys nothing.
 *
 * `\A` and `\z`, never `^` and `$`: PHP's `$` also matches immediately before a trailing
 * newline, which would leave this gate exactly one newline wide — `[acme]\n<script>…`.
 *
 * @param mixed $raw the wpj_render query value, as received
 * @return bool true when the payload is a single bare shortcode tag
 */
function wpj_render_payload_allowed($raw) {
    if (!is_string($raw)) {
        return false;
    }
    return preg_match('/\A\[[A-Za-z0-9_\-]+\]\z/', $raw) === 1;
}

/**
 * The render door's output: what do_shortcode() returned, inside the marker the runner proves
 * the endpoint ran by, which also says whether the tag EXPANDED.
 *
 * Only this side can say that for certain. WordPress returns an unregistered shortcode
 * unchanged, but a registered one may quote its own tag — Alpaca Bot's `[alpacabot_agent]`
 * answers "[alpacabot_agent] needs a url attribute." — so the runner, looking only at the text,
 * called a perfectly good expansion verbatim. An unchanged string is the definition.
 *
 * @param string $raw the payload, already through wpj_render_payload_allowed()
 * @param string $out what do_shortcode($raw) returned
 * @return string
 */
function wpj_render_wrap($raw, $out) {
    $expanded = $out !== $raw ? '1' : '0';
    return '<div data-wpj-render="1" data-wpj-expanded="' . $expanded . '">' . $out . '</div>';
}
