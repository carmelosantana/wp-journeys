<?php
/**
 * Plugin Name: wp-journeys canary
 * Description: A deliberate PHP defect, armed by an option, used to prove the sentinel can go RED. Mounted on the scratch site as an mu-plugin and left DISARMED. With `wpj_canary_armed` set it emits an undefined-variable warning during wp_head on every front-end render; without it, it does nothing at all.
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
 */

if (!defined('ABSPATH')) {
    exit;
}

add_action('wp_head', 'wpj_canary_emit');

/** The defect itself: reading an array key off a variable that was never set. */
function wpj_canary_emit() {
    if (!get_option('wpj_canary_armed')) {
        return;
    }
    $undefined = $notset['nope'];
    unset($undefined);
}
