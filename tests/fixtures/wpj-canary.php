<?php
/**
 * Plugin Name: wp-journeys canary
 * Description: A deliberate PHP defect, armed by an option, used to prove the sentinel can go RED. Mounted on the scratch site as an mu-plugin and left DISARMED. With `wpj_canary_armed` set — and only on a debugging local/development site — it emits an undefined-variable warning during wp_head on every front-end render; otherwise it does nothing at all.
 * Version: 0.1.0
 * License: MIT
 *
 * PHP 7.4-compatible syntax on purpose, like the agent.
 *
 * Armed by an OPTION rather than by mounting and unmounting the file (R22): deleting a
 * bind-mounted source file makes Docker recreate it as a root-owned empty directory, which
 * wp-harness's own mount command warns about.
 *
 *   wp option update wpj_canary_armed 1   # the suite must now FAIL
 *   wp option delete wpj_canary_armed     # the suite must now PASS
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
    /** Whether the deliberate defect may run at all: armed AND debugging AND not production. */
    function wpj_canary_armed() {
        if (!get_option('wpj_canary_armed')) {
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
}

add_action('wp_head', 'wpj_canary_emit');
