<?php
/**
 * The agent's fail-closed guard.
 *
 * This mu-plugin exposes a debug log and can mint a login for an arbitrary user, so the
 * ONLY safe default is to refuse. Every condition must be affirmatively satisfied; a
 * missing or unrecognised value is a refusal, never a pass.
 *
 * The boolean conditions count as satisfied only when the value is exactly boolean true.
 * A truthy-but-ambiguous value (the string 'false', the string '1', the int 1) is refused,
 * because an ambiguous value must refuse rather than be coerced open.
 *
 * Pure: no WordPress functions, no I/O, no globals. The caller reads the environment.
 *
 * @param array $env enabled(bool), environment_type(string), wp_debug(bool), has_secret(bool)
 * @return string '' when the agent may serve, else the reason it refuses.
 */
function wpj_guard_verdict(array $env) {
    if (!isset($env['enabled']) || $env['enabled'] !== true) {
        return 'WPJ_AGENT is not enabled';
    }
    $type = isset($env['environment_type']) ? (string) $env['environment_type'] : '';
    if ($type !== 'local' && $type !== 'development') {
        return sprintf('refusing to run with environment_type "%s"', $type);
    }
    if (!isset($env['wp_debug']) || $env['wp_debug'] !== true) {
        return 'WP_DEBUG is off';
    }
    if (!isset($env['has_secret']) || $env['has_secret'] !== true) {
        return 'no shared secret is configured';
    }
    return '';
}
