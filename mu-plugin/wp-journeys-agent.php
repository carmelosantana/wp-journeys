<?php
/**
 * Plugin Name: wp-journeys agent
 * Description: Dev-only bridge for the wp-journeys runner. Refuses to serve unless explicitly enabled on a local/development site with WP_DEBUG on and a shared secret configured.
 *
 * PHP 7.4-compatible syntax on purpose: this file runs on whatever WordPress the runner is
 * pointed at, not on the runner's own toolchain.
 */

require_once __DIR__ . '/src/guard.php';
require_once __DIR__ . '/src/discovery.php';

/** Read the live environment into the shape wpj_guard_verdict() expects. */
function wpj_agent_env() {
    return array(
        'enabled' => defined('WPJ_AGENT') && WPJ_AGENT === true,
        'environment_type' => function_exists('wp_get_environment_type') ? wp_get_environment_type() : '',
        'wp_debug' => defined('WP_DEBUG') && WP_DEBUG === true,
        'has_secret' => defined('WPJ_AGENT_SECRET') && is_string(WPJ_AGENT_SECRET) && strlen(WPJ_AGENT_SECRET) >= 16,
    );
}

add_action('rest_api_init', function () {
    register_rest_route('wp-journeys/v1', '/agent', array(
        'methods' => 'POST',
        'permission_callback' => '__return_true', // the guard below is the real gate
        'callback' => 'wpj_agent_dispatch',
    ));
});

function wpj_agent_dispatch($request) {
    $verdict = wpj_guard_verdict(wpj_agent_env());
    if ($verdict !== '') {
        return new WP_Error('wpj_refused', $verdict, array('status' => 403));
    }
    $sent = (string) $request->get_header('x-wpj-secret');
    if (!hash_equals(WPJ_AGENT_SECRET, $sent)) {
        return new WP_Error('wpj_refused', 'shared secret mismatch', array('status' => 403));
    }

    $action = (string) $request->get_param('action');
    switch ($action) {
        case 'status':
            return array(
                'ok' => true,
                'wp' => get_bloginfo('version'),
                'php' => PHP_VERSION,
                'debugLog' => defined('WP_DEBUG_LOG') && WP_DEBUG_LOG,
            );
        case 'discover':
            return wpj_discover();
    }
    return new WP_Error('wpj_unknown_action', sprintf('unknown action "%s"', $action), array('status' => 400));
}
