<?php
/**
 * Plugin Name: wp-journeys agent
 * Description: Dev-only bridge for the wp-journeys runner. Refuses to serve unless explicitly enabled on a local/development site with WP_DEBUG on and a shared secret configured.
 *
 * PHP 7.4-compatible syntax on purpose: this file runs on whatever WordPress the runner is
 * pointed at, not on the runner's own toolchain.
 *
 * Three doors, one gate: the REST route serves most actions; discovery is served from
 * admin-post.php, because only there is is_admin() true, and many plugins register their
 * admin menus only when it is; and a minted `?wpj_login=` URL logs a browser in as one of the
 * runner's own actors. That last door is opened by a navigation, which cannot carry the secret
 * header, so the single-use token in the URL is its credential — behind the same guard.
 */

require_once __DIR__ . '/src/guard.php';
require_once __DIR__ . '/src/discovery.php';
require_once __DIR__ . '/src/snapshot.php';
require_once __DIR__ . '/src/logtail.php';
require_once __DIR__ . '/src/actors.php';

/** Read the live environment into the shape wpj_guard_verdict() expects. */
function wpj_agent_env() {
    return array(
        'enabled' => defined('WPJ_AGENT') && WPJ_AGENT === true,
        'environment_type' => function_exists('wp_get_environment_type') ? wp_get_environment_type() : '',
        'wp_debug' => defined('WP_DEBUG') && WP_DEBUG === true,
        'has_secret' => defined('WPJ_AGENT_SECRET') && is_string(WPJ_AGENT_SECRET) && strlen(WPJ_AGENT_SECRET) >= 16,
    );
}

/**
 * The single gate for both doors: the guard, then the shared secret.
 *
 * @param string $sent the X-WPJ-Secret header as received
 * @return string '' when the request may be served, else the reason it is refused.
 */
function wpj_agent_refusal($sent) {
    $verdict = wpj_guard_verdict(wpj_agent_env());
    if ($verdict !== '') {
        return $verdict;
    }
    if (!hash_equals(WPJ_AGENT_SECRET, (string) $sent)) {
        return 'shared secret mismatch';
    }
    return '';
}

add_action('rest_api_init', function () {
    register_rest_route('wp-journeys/v1', '/agent', array(
        'methods' => 'POST',
        'permission_callback' => '__return_true', // wpj_agent_refusal() is the real gate
        'callback' => 'wpj_agent_dispatch',
    ));
});

function wpj_agent_dispatch($request) {
    $refusal = wpj_agent_refusal($request->get_header('x-wpj-secret'));
    if ($refusal !== '') {
        return new WP_Error('wpj_refused', $refusal, array('status' => 403));
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
        case 'snapshot':
            return wpj_snapshot();
        case 'logDelta':
            return wpj_log_delta($request->get_param('args')['offset'] ?? 0);
        case 'ensureActor':
            return wpj_ensure_actor(wpj_agent_arg($request, 'role', ''));
        case 'mintLogin':
            return wpj_mint_login(wpj_agent_arg($request, 'userId', 0));
    }
    return new WP_Error('wpj_unknown_action', sprintf('unknown action "%s"', $action), array('status' => 400));
}

/**
 * One value out of the request's `args` object.
 *
 * An array is replaced by the default rather than cast: "Array to string conversion" would
 * write a warning to debug.log, and the runner reads that log as the plugin under test's
 * signal.
 *
 * @param WP_REST_Request $request
 * @param string          $name
 * @param mixed           $default
 * @return mixed
 */
function wpj_agent_arg($request, $name, $default) {
    $args = $request->get_param('args');
    if (!is_array($args) || !isset($args[$name]) || is_array($args[$name])) {
        return $default;
    }
    return $args[$name];
}

// Both hooks: a secret-only request is logged out (nopriv), but a stray admin cookie must not
// turn discovery into a 400.
add_action('admin_post_nopriv_wpj_discover', 'wpj_agent_discover_endpoint');
add_action('admin_post_wpj_discover', 'wpj_agent_discover_endpoint');

/** admin-post.php?action=wpj_discover: the same gate and the same JSON shapes as the REST route. */
function wpj_agent_discover_endpoint() {
    $sent = isset($_SERVER['HTTP_X_WPJ_SECRET']) ? wp_unslash($_SERVER['HTTP_X_WPJ_SECRET']) : '';
    $refusal = wpj_agent_refusal($sent);
    $result = $refusal !== ''
        ? new WP_Error('wpj_refused', $refusal, array('status' => 403))
        : wpj_discover();

    if (is_wp_error($result)) {
        $data = $result->get_error_data();
        $status = is_array($data) && isset($data['status']) ? (int) $data['status'] : 500;
        // The shape WP_REST_Server gives a WP_Error, so the client reads both doors alike.
        wp_send_json(array(
            'code' => $result->get_error_code(),
            'message' => $result->get_error_message(),
            'data' => array('status' => $status),
        ), $status);
    }
    wp_send_json($result, 200);
}

// The third door: a browser following a minted URL. It runs on every request, so it does as
// little as possible before deciding this is not one of ours.
add_action('init', 'wpj_agent_login_endpoint');

/**
 * `?wpj_login=<token>`: spend the token and authenticate as that actor.
 *
 * The guard applies here exactly as it does to the other doors — on a site the agent may not
 * serve, a token is inert. The shared secret deliberately does NOT apply: a browser navigation
 * cannot carry the header, so the single-use token is the credential, and it only ever names a
 * user the runner created.
 */
function wpj_agent_login_endpoint() {
    $raw = isset($_GET['wpj_login']) ? wp_unslash($_GET['wpj_login']) : '';
    if (!is_string($raw) || $raw === '') {
        return;
    }
    if (wpj_guard_verdict(wpj_agent_env()) !== '') {
        return;
    }
    wpj_consume_login(sanitize_text_field($raw));
}
