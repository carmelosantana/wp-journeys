<?php
/**
 * Removes what activation created: the option, the table and the user meta.
 *
 * It deliberately does NOT clear the wpj_fixture_daily cron event. That is the intentional
 * leak documented in the plugin header, and the orphan detector's one known positive.
 */

if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

global $wpdb; // uninstall_plugin() includes this file from inside a function

delete_option('wpj_fixture_version');
$wpdb->query("DROP TABLE IF EXISTS {$wpdb->prefix}wpj_fixture_log");
delete_metadata('user', 0, 'wpj_fixture_seen', '', true); // from every user, not just the first admin

// No wp_clear_scheduled_hook('wpj_fixture_daily') here, on purpose: see the plugin header.
