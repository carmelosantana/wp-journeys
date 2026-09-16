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
 * So the gate is the exact shape the runner sends and nothing else: one bare shortcode tag,
 * with any tag name core itself would register.
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
    // The tag class is core's own (wp-includes/shortcodes.php:75 refuses @[<>&/\[\]\x00-\x20=]@),
    // widened at first contact from [A-Za-z0-9_-], which refused legal tags like [my.tag] and
    // failed their render as the plugin's defect. It cannot carry markup (<, >, &), an ASCII
    // space or '='. It CAN carry other characters an attribute might use — '"', "'", a
    // non-breaking space — so this gate alone does not keep attributes out. What does is core's
    // exact-name pre-filter: do_shortcode() collects the whole bracketed name with that same class
    // and runs only names registered VERBATIM, so "[acme\xC2\xA0x]" or '[acme"x]' is not "[acme]"
    // with an attribute but an unregistered name, returned unchanged (and escaped by nothing, which
    // is why markup stays refused here). tests/e2e/conformance.spec.ts proves it live.
    return preg_match('/\A\[[^<>&\/\[\]\x00-\x20=]+\]\z/', $raw) === 1;
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

/**
 * The block door's payload gate (R57): one block name, in exactly the shape
 * WP_Block_Type_Registry::register() accepts, and nothing else. The same reasoning as the
 * shortcode gate above — this door carries no credential beyond the guard.
 *
 * @param mixed $raw the wpj_render_block query value, as received
 * @return bool
 */
function wpj_render_block_payload_allowed($raw) {
    if (!is_string($raw)) {
        return false;
    }
    return preg_match('/\A[a-z0-9-]+\/[a-z0-9-]+\z/', $raw) === 1;
}

/**
 * The block door's output. `registered` because render_block() answers a block the registry
 * does not know with an empty string, not an error, so an unregistered name would otherwise
 * render "cleanly". `dynamic` because only a dynamic block has a server render to exercise; a
 * static block's markup lives in post content, so for it the render proves registration and a
 * clean render_block filter chain, and no more.
 *
 * @param bool   $registered
 * @param bool   $dynamic
 * @param string $out what render_block() returned
 * @return string
 */
function wpj_render_block_wrap($registered, $dynamic, $out) {
    return '<div data-wpj-render-block="1" data-wpj-registered="' . ($registered ? '1' : '0')
        . '" data-wpj-dynamic="' . ($dynamic ? '1' : '0') . '">' . $out . '</div>';
}
