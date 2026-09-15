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
    global $menu, $submenu, $shortcode_tags, $wp_roles;

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
    );
}

/**
 * Build the admin menu the way wp-admin does: core's own screens (wp-admin/menu.php), then
 * `_admin_menu` and `admin_menu` for every plugin, then core's privilege pruning.
 *
 * menu.php is written for global scope. Included from here, its variables would be this
 * function's locals, so every global it or a plugin's add_*_page() call reads is bound first.
 */
function wpj_build_admin_menu() {
    global $menu, $submenu, $compat, $admin_page_hooks, $_registered_pages, $_parent_pages,
        $_wp_real_parent_file, $_wp_submenu_nopriv, $_wp_menu_nopriv,
        $_wp_last_object_menu, $_wp_last_utility_menu;

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
