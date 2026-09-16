<?php
/**
 * Plugin Name: wp-journeys canary
 * Description: Two deliberate defects, each armed by its own option, used to prove the sentinel can go RED. Mounted on the scratch site as an mu-plugin and left DISARMED. With `wpj_canary_armed` set it emits an undefined-variable warning during wp_head on every front-end render; with `wpj_canary_js` set it prints an inline script on wp_footer that throws an uncaught JavaScript error. Either runs only on a debugging local/development site; otherwise the file does nothing at all.
 * Version: 0.1.0
 * License: MIT
 *
 * PHP 7.4-compatible syntax on purpose, like the agent.
 *
 * Armed by an OPTION rather than by mounting and unmounting the file (R22): deleting a
 * bind-mounted source file makes Docker recreate it as a root-owned empty directory, which
 * wp-harness's own mount command warns about.
 *
 *   wp option update wpj_canary_armed 1   # the suite must now FAIL (phplog / bodyscan)
 *   wp option delete wpj_canary_armed     # the suite must now PASS
 *   wp option update wpj_canary_js 1      # the suite must now FAIL (pageerror)
 *   wp option delete wpj_canary_js        # the suite must now PASS
 *
 * It FAILS CLOSED, to the same standard as the agent it exists to test: the option alone is not
 * enough. WP_DEBUG must be on and the environment must be local or development, so a copy of
 * this file that reaches a production site — or an option name someone guesses — still does
 * nothing.
 */

if (!defined('ABSPATH')) {
    exit;
}

if (!function_exists('wpj_canary_emit')) {
    /** Whether a deliberate defect may run at all: its option set AND debugging AND not production. */
    function wpj_canary_armed($option = 'wpj_canary_armed') {
        if (!get_option($option)) {
            return false;
        }
        if (!defined('WP_DEBUG') || !WP_DEBUG) {
            return false;
        }
        if (!function_exists('wp_get_environment_type')) {
            return false;
        }
        $environment = wp_get_environment_type();

        return $environment === 'local' || $environment === 'development';
    }

    /** The defect itself: reading an array key off a variable that was never set. */
    function wpj_canary_emit() {
        if (!wpj_canary_armed()) {
            return;
        }
        $undefined = $notset['nope'];
        unset($undefined);
    }

    /**
     * The client-side defect: a script that throws on load. Playwright reports that only as a
     * `pageerror`, never as a console message, which is what this exists to prove is caught.
     */
    function wpj_canary_emit_js() {
        if (!wpj_canary_armed('wpj_canary_js')) {
            return;
        }
        echo "<script>throw new Error('wpj-canary: deliberate uncaught JavaScript error');</script>\n";
    }
}

add_action('wp_head', 'wpj_canary_emit');
add_action('wp_footer', 'wpj_canary_emit_js');
