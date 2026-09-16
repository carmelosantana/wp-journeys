<?php
/**
 * The render door's payload gate (R55).
 *
 * Pure: no WordPress functions, no I/O, so tests/php can assert it.
 *
 * The render doors are reached by a browser navigation, which carries no header, so they cannot
 * use the shared-secret header the REST and discovery doors use. They carry a signed, expiring
 * URL instead (wpj_render_signature_valid() below). The payload gate is kept as well: a signature
 * says the runner asked for this render, not that the payload is safe to echo.
 *
 * Its output is echoed unescaped. Without this gate `?wpj_render=<script>…` is reflected
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
 * shortcode gate above.
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

/**
 * How long a signed render URL may live, in seconds, measured from the moment it is checked.
 * The runner signs for less than this; the cap is what stops a signature minted with a far
 * future expiry from working forever.
 */
const WPJ_RENDER_MAX_TTL = 600;

/**
 * The render doors' signature: HMAC-SHA256 over the door, the payload and the expiry, keyed by
 * the shared secret. src/agent/render.ts computes the same bytes; a test vector in both test
 * suites pins the two to each other.
 *
 * @param string $kind    the door's query parameter: 'wpj_render' or 'wpj_render_block'
 * @param string $payload the door's payload, as received
 * @param string $exp     the expiry, as received
 * @param string $secret
 * @return string lowercase hex
 */
function wpj_render_signature($kind, $payload, $exp, $secret) {
    return hash_hmac('sha256', $kind . "\n" . $payload . "\n" . $exp, $secret);
}

/**
 * Whether a render door request carries a valid signature.
 *
 * Why the doors carry one at all: without it, anyone who could reach a guarded dev site — or a
 * cross-site page steering a logged-in admin's browser there — could run any registered
 * shortcode or block callback. The signature is bound to the door and the payload, so a leaked
 * URL renders only that one thing, and only until it expires.
 *
 * Stateless on purpose, never single-use: the runner retries a navigation once on a benign
 * network fault, and a spent token would turn that retry into a false red.
 *
 * Pure: the clock is a parameter, so tests/php can assert every edge.
 *
 * @param string $kind    the door's query parameter: 'wpj_render' or 'wpj_render_block'
 * @param mixed  $payload the door's payload, as received
 * @param mixed  $exp     wpj_exp as received: a decimal integer of unix seconds
 * @param mixed  $sig     wpj_sig as received: lowercase hex
 * @param string $secret  the shared secret
 * @param int    $now     the current unix time
 * @return bool
 */
function wpj_render_signature_valid($kind, $payload, $exp, $sig, $secret, $now) {
    if (!is_string($payload) || !is_string($exp) || !is_string($sig) || !is_string($secret)) {
        return false;
    }
    if (strlen($secret) < 16) {
        return false;
    }
    // Digits only, and \z rather than $ so a trailing newline is not an integer.
    if (preg_match('/\A[0-9]{1,12}\z/', $exp) !== 1) {
        return false;
    }
    $expires = (int) $exp;
    if ($now > $expires || $expires > $now + WPJ_RENDER_MAX_TTL) {
        return false;
    }
    return hash_equals(wpj_render_signature($kind, $payload, $exp, $secret), $sig);
}
