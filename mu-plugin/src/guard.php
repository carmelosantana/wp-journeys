<?php
/**
 * The agent's fail-closed guard.
 *
 * This mu-plugin exposes a debug log and can mint a login for an arbitrary user, so the
 * ONLY safe default is to refuse. Every condition must be affirmatively satisfied; a
 * missing or unrecognised value is a refusal, never a pass.
 *
 * Pure: no WordPress functions, no I/O, no globals. The caller reads the environment.
 *
 * @param array $env enabled(bool), environment_type(string), wp_debug(bool), has_secret(bool)
 * @return string '' when the agent may serve, else the reason it refuses.
 */
function wpj_guard_verdict(array $env) {
    if (empty($env['enabled'])) {
        return 'WPJ_AGENT is not enabled';
    }
    $type = isset($env['environment_type']) ? (string) $env['environment_type'] : '';
    if ($type !== 'local' && $type !== 'development') {
        return sprintf('refusing to run with environment_type "%s"', $type);
    }
    if (empty($env['wp_debug'])) {
        return 'WP_DEBUG is off';
    }
    if (empty($env['has_secret'])) {
        return 'no shared secret is configured';
    }
    return '';
}
