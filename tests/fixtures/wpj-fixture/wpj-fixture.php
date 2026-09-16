<?php
/**
 * Plugin Name: wp-journeys fixture
 * Description: Test fixture with a KNOWN surface, so discovery's plugin attribution can be proven. It registers exactly: admin pages wpj-fixture (top level), wpj-fixture-settings (under it), wpj-fixture-options (under core Settings), wpj-fixture-admin-only (top level, registered only when is_admin()), wpj-fixture/wpj-fixture.php (top level, registered with __FILE__ as its slug), wpj-fixture-file-child (under that), wpj-fixture-container (top level, registered with NO callback, so it is a "container" WordPress links at its first submenu) wpj-fixture-container-home (under that container), wpj-fixture-served (top level, WITH a callback, whose auto-added mirror row is removed) and wpj-fixture-served-child (under it); shortcode wpj_fixture; dynamic block wpj-fixture/hello; REST route wpj-fixture/v1/ping. It also turns on custom_menu_order with a menu_order filter, which adds no surface but exercises core's sort_menu(). Add nothing else here: the live proof expects exactly these.
 * Version: 0.1.0
 * License: MIT
 *
 * PHP 7.4-compatible syntax on purpose, like the agent.
 *
 * Activation-time state, separate from the surface above. On activation it creates exactly:
 * option wpj_fixture_version, table {$wpdb->prefix}wpj_fixture_log, the daily cron event
 * wpj_fixture_daily, and user meta wpj_fixture_seen on the first administrator. uninstall.php
 * removes all of it EXCEPT the cron event. That omission is an INTENTIONAL LEAK, so the
 * uninstall-orphan detector always has one known positive to catch (and the three it does
 * remove are its known negatives). Do not "fix" it.
 */

if (!defined('ABSPATH')) {
    exit;
}

register_activation_hook(__FILE__, 'wpj_fixture_activate');

/** Create the activation-time state documented in the header: one of each kind. */
function wpj_fixture_activate() {
    global $wpdb;

    update_option('wpj_fixture_version', '0.1.0');

    $table = $wpdb->prefix . 'wpj_fixture_log';
    $wpdb->query("CREATE TABLE IF NOT EXISTS {$table} (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, PRIMARY KEY (id)) " . $wpdb->get_charset_collate());

    if (!wp_next_scheduled('wpj_fixture_daily')) {
        wp_schedule_event(time(), 'daily', 'wpj_fixture_daily');
    }

    $admins = get_users(array('role' => 'administrator', 'orderby' => 'ID', 'order' => 'ASC', 'number' => 1, 'fields' => 'ID'));
    if ($admins) {
        update_user_meta((int) $admins[0], 'wpj_fixture_seen', '1');
    }
}

add_action('admin_menu', 'wpj_fixture_admin_menu');

function wpj_fixture_admin_menu() {
    add_menu_page('WPJ Fixture', 'WPJ Fixture', 'manage_options', 'wpj-fixture', 'wpj_fixture_render_page');
    add_submenu_page('wpj-fixture', 'WPJ Fixture Settings', 'Settings', 'manage_options', 'wpj-fixture-settings', 'wpj_fixture_render_settings');
    // Under a CORE parent: WordPress's menu links it at options-general.php?page=.
    add_options_page('WPJ Fixture Options', 'WPJ Fixture Options', 'manage_options', 'wpj-fixture-options', 'wpj_fixture_render_options');
    // The long-standing __FILE__ slug pattern: add_menu_page() runs plugin_basename() on it,
    // so the slug is "wpj-fixture/wpj-fixture.php", served at admin.php?page=<that slug>.
    add_menu_page('WPJ Fixture File', 'WPJ Fixture File', 'manage_options', __FILE__, 'wpj_fixture_render_file');
    add_submenu_page(__FILE__, 'WPJ Fixture File Child', 'File Child', 'manage_options', 'wpj-fixture-file-child', 'wpj_fixture_render_file_child');
    // A CONTAINER top-level menu (R28): registered with NO callback, so nothing serves
    // /wp-admin/wpj-fixture-container and nothing serves admin.php?page=wpj-fixture-container
    // either. WordPress's own menu links such an item at its FIRST submenu's URL. A projection
    // that sends it to its own slug reports a 404 against the plugin under test.
    add_menu_page('WPJ Fixture Container', 'WPJ Fixture Container', 'manage_options', 'wpj-fixture-container');
    add_submenu_page('wpj-fixture-container', 'WPJ Fixture Container Home', 'Home', 'manage_options', 'wpj-fixture-container-home', 'wpj_fixture_render_container_home');
    // add_submenu_page() links the parent back to itself as the FIRST submenu row. Dropping
    // that row is the common way plugins avoid a duplicated first item, and it is what leaves
    // the container in the shape R28 is about: a top-level whose first submenu carries a
    // DIFFERENT slug. WordPress then links the menu at that submenu instead.
    remove_submenu_page('wpj-fixture-container', 'wpj-fixture-container');
    // The same mirror-dropping pattern on a top-level that DOES serve its own page: it has a
    // callback, so it is in $_parent_pages and admin.php?page=wpj-fixture-served is a real
    // screen. WordPress links the menu at the child, but the parent screen still exists — so
    // the sweep must keep driving it, or a fatal there would be invisible (R56).
    add_menu_page('WPJ Fixture Served', 'WPJ Fixture Served', 'manage_options', 'wpj-fixture-served', 'wpj_fixture_render_served');
    add_submenu_page('wpj-fixture-served', 'WPJ Fixture Served Child', 'Child', 'manage_options', 'wpj-fixture-served-child', 'wpj_fixture_render_served_child');
    remove_submenu_page('wpj-fixture-served', 'wpj-fixture-served');
}

function wpj_fixture_render_container_home() {
    echo '<div class="wrap"><h1>WPJ Fixture Container Home</h1></div>';
}

function wpj_fixture_render_served() {
    echo '<div class="wrap"><h1>WPJ Fixture Served</h1></div>';
}

function wpj_fixture_render_served_child() {
    echo '<div class="wrap"><h1>WPJ Fixture Served Child</h1></div>';
}

// Opt in to custom menu ordering, as WooCommerce and admin-menu editors do, so core's
// sort_menu() runs during every menu build.
add_filter('custom_menu_order', '__return_true');
add_filter('menu_order', 'wpj_fixture_menu_order');

/** Move the fixture's top-level page to just after the Dashboard. */
function wpj_fixture_menu_order($order) {
    $at = array_search('wpj-fixture', $order, true);
    if ($at === false) {
        return $order;
    }
    array_splice($order, $at, 1);
    array_splice($order, 1, 0, 'wpj-fixture');
    return $order;
}

function wpj_fixture_render_file() {
    echo '<div class="wrap"><h1>WPJ Fixture File</h1></div>';
}

function wpj_fixture_render_file_child() {
    echo '<div class="wrap"><h1>WPJ Fixture File Child</h1></div>';
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
