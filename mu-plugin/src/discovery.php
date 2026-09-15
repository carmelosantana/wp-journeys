<?php
/**
 * Project WordPress's own registries to JSON.
 *
 * Everything here is read-only introspection of globals WordPress already maintains. The
 * admin menu only exists after wp-admin has bootstrapped, so the menu globals are loaded
 * explicitly rather than assumed present.
 *
 * The wpj_discover_*() helpers are pure (no WordPress calls) so tests/php can assert them.
 */
function wpj_discover() {
    $admins = get_users(array(
        'role' => 'administrator',
        'orderby' => 'ID',
        'order' => 'ASC',
        'number' => 1,
        'fields' => 'ID',
    ));
    if (empty($admins)) {
        return new WP_Error('wpj_no_administrator', 'discovery needs an administrator to build the admin menu as', array('status' => 409));
    }

    // add_submenu_page() silently drops an entry the current user cannot see, and a request
    // authenticated only by the shared secret runs as user 0. Build the menu as the first
    // administrator so the whole surface is visible; the runner does its own per-actor
    // permission checks from the capability on each row.
    $previous_user = get_current_user_id();
    wp_set_current_user((int) $admins[0]);
    try {
        wpj_build_admin_menu();
    } finally {
        wp_set_current_user($previous_user);
    }
    global $menu, $submenu, $shortcode_tags, $wp_roles, $_parent_pages;

    $blocks = array();
    if (class_exists('WP_Block_Type_Registry')) {
        $blocks = array_keys(WP_Block_Type_Registry::get_instance()->get_all_registered());
    }

    $roles = array();
    if (isset($wp_roles) && isset($wp_roles->roles)) {
        foreach ($wp_roles->roles as $name => $role) {
            $granted = array();
            foreach ((array) $role['capabilities'] as $cap => $has) {
                if ($has) { $granted[] = $cap; }
            }
            sort($granted);
            $roles[$name] = $granted;
        }
    }

    return array(
        'menu' => array_values(is_array($menu) ? $menu : array()),
        'submenu' => wpj_discover_submenu(is_array($submenu) ? $submenu : array()),
        'blocks' => $blocks,
        'shortcodes' => array_keys(is_array($shortcode_tags) ? $shortcode_tags : array()),
        'routes' => wpj_discover_routes(rest_get_server()->get_routes()),
        'roles' => $roles,
        'pluginPages' => wpj_discover_plugin_pages(is_array($_parent_pages) ? $_parent_pages : array(), 'wpj_serves_by_page'),
    );
}

/**
 * Build the admin menu the way wp-admin does: core's own screens (wp-admin/menu.php), then
 * `_admin_menu` and `admin_menu` for every plugin, then core's privilege pruning.
 *
 * wp-admin/menu.php and wp-admin/includes/menu.php are written for global scope. Required from
 * here, every variable they assign would be this function's local, and any core function that
 * reads it through `global` would see null. So every file-scope variable of those two files
 * that core anywhere declares `global` is bound first. The list comes from a token-level audit
 * of WP 7.1:
 *   - menu registries: $menu $submenu $compat $admin_page_hooks $_wp_real_parent_file
 *     $_wp_submenu_nopriv $_wp_menu_nopriv $_wp_last_object_menu $_wp_last_utility_menu
 *   - custom ordering: $menu_order $default_menu_order, read by sort_menu(). Unbound, every
 *     plugin that enables `custom_menu_order` (WooCommerce, menu editors) had its order
 *     silently dropped and a PHP warning written to debug.log, which was then blamed on it.
 *   - loop temporaries that share a name with a core global: $id $post_type $taxonomy
 *     (bound so the build behaves exactly as it does at global scope in wp-admin)
 * $_registered_pages and $_parent_pages are not assigned there, but add_*_page() writes them.
 */
function wpj_build_admin_menu() {
    global $menu, $submenu, $compat, $admin_page_hooks, $_registered_pages, $_parent_pages,
        $_wp_real_parent_file, $_wp_submenu_nopriv, $_wp_menu_nopriv,
        $_wp_last_object_menu, $_wp_last_utility_menu,
        $menu_order, $default_menu_order,
        $id, $post_type, $taxonomy;

    require_once ABSPATH . 'wp-admin/includes/admin.php';
    if (!did_action('admin_menu')) {
        require_once ABSPATH . 'wp-admin/menu.php';
    }
}

/**
 * `$submenu` rows are keyed by menu position (0, 10, 15 ...), which json_encode() would turn
 * into an object. The runner reads each parent's rows as a list, so hand them over as one.
 *
 * @param array $submenu parent slug => position => row
 * @return array parent slug => list of rows, in WordPress's order
 */
function wpj_discover_submenu(array $submenu) {
    $lists = array();
    foreach ($submenu as $parent => $rows) {
        $lists[$parent] = array_values((array) $rows);
    }
    return $lists;
}

/**
 * WordPress's plugin-page registry, as the list of slugs it serves by `?page=`.
 *
 * `$_parent_pages` (slug => parent, or false at top level) is the registry add_menu_page() and
 * add_submenu_page() write and menu_page_url() keys on. But core writes callback-less screens
 * into it too: theme-editor.php and plugin-editor.php under Tools, and every custom post type
 * list screen (`edit.php?post_type=x`) that `show_in_menu` hangs under a plugin menu. Those are
 * served at their own path, so each entry is kept only if `$serves_by_page` says WordPress
 * itself would link it by `?page=`.
 *
 * @param array    $parent_pages   slug => parent slug, or false for a top-level page
 * @param callable $serves_by_page function (string $slug, string $parent): bool; a top-level
 *                                 page is asked with parent 'admin.php', as menu-header.php does
 * @return string[] slugs, in registry order
 */
function wpj_discover_plugin_pages(array $parent_pages, $serves_by_page) {
    $pages = array();
    foreach ($parent_pages as $slug => $parent) {
        $slug = (string) $slug;
        if (call_user_func($serves_by_page, $slug, $parent === false ? 'admin.php' : (string) $parent)) {
            $pages[] = $slug;
        }
    }
    return $pages;
}

/**
 * WordPress's own test, from wp-admin/menu-header.php, for "link this item by ?page=": a page
 * hook is registered for it, or it names a plugin file that is not a wp-admin file.
 */
function wpj_serves_by_page($slug, $parent) {
    if (get_plugin_page_hook($slug, $parent)) {
        return true;
    }
    $parts = explode('?', $slug, 2);
    $file = $parts[0];
    return $slug !== 'index.php'
        && file_exists(WP_PLUGIN_DIR . '/' . $file)
        && !file_exists(ABSPATH . 'wp-admin/' . $file);
}

/**
 * Project WP_REST_Server::get_routes() to route => {methods, guarded}.
 *
 * WordPress registers a namespace index handler for every namespace on its own
 * (WP_REST_Server::register_route). The plugin did not write it and it has no permission
 * callback, so reporting it would blame the plugin for an unguarded route it never
 * registered. Those handlers are skipped; a route left with no handlers is dropped.
 *
 * @param array $routes route => list of normalised handlers
 * @return array route => array('methods' => string[], 'guarded' => bool)
 */
function wpj_discover_routes(array $routes) {
    $projected = array();
    foreach ($routes as $route => $handlers) {
        $methods = array();
        $guarded = false;
        $kept = 0;
        foreach ($handlers as $handler) {
            if (wpj_is_namespace_index($handler)) {
                continue;
            }
            $kept++;
            foreach (array_keys((array) $handler['methods']) as $method) {
                $methods[$method] = true;
            }
            $cb = isset($handler['permission_callback']) ? $handler['permission_callback'] : null;
            if ($cb !== null && $cb !== '__return_true') {
                $guarded = true;
            }
        }
        if ($kept === 0) {
            continue;
        }
        $projected[$route] = array('methods' => array_keys($methods), 'guarded' => $guarded);
    }
    return $projected;
}

/** True only for WordPress's own namespace index handler, not a look-alike method name. */
function wpj_is_namespace_index($handler) {
    $cb = isset($handler['callback']) ? $handler['callback'] : null;
    return is_array($cb)
        && isset($cb[0], $cb[1])
        && $cb[0] instanceof WP_REST_Server
        && $cb[1] === 'get_namespace_index';
}
