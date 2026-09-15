<?php
require __DIR__ . '/assert.php';

/** Stand-in for WordPress's REST server: only its identity matters to the projection. */
class WP_REST_Server {
    public function get_namespace_index() {}
}
/** A plugin controller that happens to share the method name must not be mistaken for it. */
class Wpj_Test_Controller {
    public function get_namespace_index() {}
}

require __DIR__ . '/../../mu-plugin/src/discovery.php';

$server = new WP_REST_Server();
$index = array('methods' => array('GET' => true), 'callback' => array($server, 'get_namespace_index'));

// The shape WP_REST_Server::get_routes() returns: route -> list of normalised handlers.
$routes = array(
    '/acme/v1' => array($index),
    '/acme/v1/items' => array(
        array('methods' => array('GET' => true), 'callback' => 'acme_list', 'permission_callback' => 'acme_can'),
        array('methods' => array('POST' => true), 'callback' => 'acme_add', 'permission_callback' => 'acme_can'),
    ),
    '/acme/v1/open' => array(array('methods' => array('GET' => true), 'callback' => 'acme_open', 'permission_callback' => '__return_true')),
    '/acme/v1/bare' => array(array('methods' => array('GET' => true), 'callback' => 'acme_bare')),
    '/acme/v1/lookalike' => array(array(
        'methods' => array('GET' => true),
        'callback' => array(new Wpj_Test_Controller(), 'get_namespace_index'),
        'permission_callback' => 'acme_can',
    )),
);

$projected = wpj_discover_routes($routes);

wpj_assert(
    'drops the namespace index route WordPress registers for every namespace',
    false,
    array_key_exists('/acme/v1', $projected)
);
wpj_assert(
    'merges the methods of every handler on a route and marks it guarded',
    array('methods' => array('GET', 'POST'), 'guarded' => true),
    $projected['/acme/v1/items']
);
wpj_assert(
    'a __return_true permission callback is unguarded',
    array('methods' => array('GET'), 'guarded' => false),
    $projected['/acme/v1/open']
);
wpj_assert(
    'a missing permission callback is unguarded',
    array('methods' => array('GET'), 'guarded' => false),
    $projected['/acme/v1/bare']
);
wpj_assert(
    'keeps a plugin handler that merely shares the namespace-index method name',
    array('methods' => array('GET'), 'guarded' => true),
    $projected['/acme/v1/lookalike']
);
wpj_assert(
    'a plugin handler added to a namespace-index route survives without the index handler',
    array('/acme/v1' => array('methods' => array('POST'), 'guarded' => true)),
    wpj_discover_routes(array('/acme/v1' => array(
        $index,
        array('methods' => array('POST' => true), 'callback' => 'acme_root', 'permission_callback' => 'acme_can'),
    )))
);

wpj_assert(
    'submenu rows keyed by menu position become a list, so they reach JSON as an array',
    array('index.php' => array(array('Home', 'read', 'index.php'), array('Updates', 'update_core', 'update-core.php'))),
    wpj_discover_submenu(array('index.php' => array(
        0 => array('Home', 'read', 'index.php'),
        10 => array('Updates', 'update_core', 'update-core.php'),
    )))
);

// WordPress's plugin-page registry, $_parent_pages: slug => parent slug, or false at top level.
// Core also writes callback-less screens into it (theme-editor.php, CPT list screens), which
// the predicate (WordPress's own menu-header test) must be able to leave out.
$parent_pages = array(
    'wpj-plugin/wpj-plugin.php' => false,
    'wpj-plugin-child' => 'wpj-plugin/wpj-plugin.php',
    'theme-editor.php' => 'tools.php',
    'edit.php?post_type=acme_item' => 'acme',
);
$asked = array();
$serves_by_page = function ($slug, $parent) use (&$asked) {
    $asked[] = array($slug, $parent);
    return in_array($slug, array('wpj-plugin/wpj-plugin.php', 'wpj-plugin-child'), true);
};
wpj_assert(
    'lists only the registered pages WordPress would serve by ?page=, in registry order',
    array('wpj-plugin/wpj-plugin.php', 'wpj-plugin-child'),
    wpj_discover_plugin_pages($parent_pages, $serves_by_page)
);
wpj_assert(
    'asks with parent admin.php for a top-level page, as wp-admin/menu-header.php does',
    array('wpj-plugin/wpj-plugin.php', 'admin.php'),
    $asked[0]
);
wpj_assert(
    'asks with the registered parent for a submenu page',
    array('wpj-plugin-child', 'wpj-plugin/wpj-plugin.php'),
    $asked[1]
);

wpj_assert_exit();
