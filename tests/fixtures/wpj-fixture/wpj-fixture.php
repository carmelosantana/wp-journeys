<?php
/**
 * Plugin Name: wp-journeys fixture
 * Description: Test fixture with a KNOWN surface, so discovery's plugin attribution can be proven. It registers exactly: admin pages wpj-fixture (top level), wpj-fixture-settings (under it), wpj-fixture-options (under core Settings) and wpj-fixture-admin-only (top level, registered only when is_admin()); shortcode wpj_fixture; dynamic block wpj-fixture/hello; REST route wpj-fixture/v1/ping. Add nothing else here: the live proof expects exactly these.
 * Version: 0.1.0
 * License: MIT
 *
 * PHP 7.4-compatible syntax on purpose, like the agent.
 */

if (!defined('ABSPATH')) {
    exit;
}

add_action('admin_menu', 'wpj_fixture_admin_menu');

function wpj_fixture_admin_menu() {
    add_menu_page('WPJ Fixture', 'WPJ Fixture', 'manage_options', 'wpj-fixture', 'wpj_fixture_render_page');
    add_submenu_page('wpj-fixture', 'WPJ Fixture Settings', 'Settings', 'manage_options', 'wpj-fixture-settings', 'wpj_fixture_render_settings');
    // Under a CORE parent: WordPress's menu links it at options-general.php?page=.
    add_options_page('WPJ Fixture Options', 'WPJ Fixture Options', 'manage_options', 'wpj-fixture-options', 'wpj_fixture_render_options');
}

// Registered ONLY in a wp-admin request, the common pattern a REST request cannot see
// (is_admin() is false there).
if (is_admin()) {
    add_action('admin_menu', 'wpj_fixture_admin_only_menu');
}

function wpj_fixture_admin_only_menu() {
    add_menu_page('WPJ Fixture Admin Only', 'WPJ Fixture Admin Only', 'manage_options', 'wpj-fixture-admin-only', 'wpj_fixture_render_admin_only');
}

function wpj_fixture_render_page() {
    echo '<div class="wrap"><h1>WPJ Fixture</h1></div>';
}

function wpj_fixture_render_settings() {
    echo '<div class="wrap"><h1>WPJ Fixture Settings</h1></div>';
}

function wpj_fixture_render_options() {
    echo '<div class="wrap"><h1>WPJ Fixture Options</h1></div>';
}

function wpj_fixture_render_admin_only() {
    echo '<div class="wrap"><h1>WPJ Fixture Admin Only</h1></div>';
}

add_shortcode('wpj_fixture', 'wpj_fixture_shortcode');

function wpj_fixture_shortcode() {
    return '<span class="wpj-fixture-shortcode">wpj fixture shortcode</span>';
}

add_action('init', 'wpj_fixture_register_block');

/** A dynamic block: rendered on the server, so it needs no JS build. */
function wpj_fixture_register_block() {
    register_block_type('wpj-fixture/hello', array(
        'render_callback' => 'wpj_fixture_render_block',
    ));
}

function wpj_fixture_render_block() {
    return '<p class="wpj-fixture-hello">Hello from wpj-fixture</p>';
}

add_action('rest_api_init', 'wpj_fixture_register_route');

function wpj_fixture_register_route() {
    register_rest_route('wpj-fixture/v1', '/ping', array(
        'methods' => 'GET',
        'callback' => 'wpj_fixture_ping',
        'permission_callback' => 'wpj_fixture_can_ping',
    ));
}

function wpj_fixture_can_ping() {
    return current_user_can('manage_options');
}

function wpj_fixture_ping() {
    return array('pong' => true);
}
