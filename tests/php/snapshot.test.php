<?php
require __DIR__ . '/assert.php';
require __DIR__ . '/../../mu-plugin/src/snapshot.php';

// The shape _get_cron_array() returns: timestamp -> hook -> event signature -> event.
$cron = array(
    1700000000 => array('wp_version_check' => array('40cd750b' => array('schedule' => 'twicedaily', 'args' => array()))),
    1700003600 => array(
        'acme_sync' => array('a1' => array('args' => array(1)), 'b2' => array('args' => array(2))),
        'wp_version_check' => array('40cd750b' => array()),
    ),
    1700000500 => array('acme_daily' => array('x' => array())),
);

wpj_assert(
    'names every hook once, sorted, however many timestamps or argument sets it has',
    array('acme_daily', 'acme_sync', 'wp_version_check'),
    wpj_snapshot_cron_hooks($cron)
);
wpj_assert(
    'a numeric hook name stays a string, so the JSON is a list of names',
    array('123'),
    wpj_snapshot_cron_hooks(array(1700000000 => array('123' => array('x' => array()))))
);
wpj_assert('an empty cron array has no hooks', array(), wpj_snapshot_cron_hooks(array()));
wpj_assert('a missing cron option (false) has no hooks, not a warning', array(), wpj_snapshot_cron_hooks(false));

// R79: the origin re-check. A hook is core's only when EVERY callback on it is DEFINED under
// wp-includes or wp-admin. has_action() alone asked whether anything at all answered, and a
// plugin's leftover mu-plugin answers its own orphaned hook.
$fake = __DIR__ . '/fixtures/fakewp';
$core_closure = require $fake . '/wp-includes/core-callbacks.php';
require $fake . '/wp-admin/admin-callbacks.php';
$left_closure = require $fake . '/wp-content/mu-plugins/leftover.php';
$core_dirs = array($fake . '/wp-includes', $fake . '/wp-admin');

$in_core = array(
    'a function-name string' => 'wpj_t_core_fn',
    'a Class::method string' => 'WPJ_T_Core::stat',
    'a [class, method] array' => array('WPJ_T_Core', 'stat'),
    'an [object, method] array' => array(new WPJ_T_Core(), 'inst'),
    'a closure' => $core_closure,
    'an invokable object' => new WPJ_T_Core(),
    'a wp-admin function' => 'wpj_t_admin_fn',
);
foreach ($in_core as $shape => $callback) {
    wpj_assert("resolves $shape defined in core", true, wpj_callback_is_core($callback, $core_dirs));
}
$outside = array(
    'a function-name string' => 'wpj_t_leftover_fn',
    'a Class::method string' => 'WPJ_T_Leftover::stat',
    'a [class, method] array' => array('WPJ_T_Leftover', 'stat'),
    'an [object, method] array' => array(new WPJ_T_Leftover(), 'inst'),
    'a closure' => $left_closure,
    'an invokable object' => new WPJ_T_Leftover(),
);
foreach ($outside as $shape => $callback) {
    wpj_assert("does not count $shape defined outside core", false, wpj_callback_is_core($callback, $core_dirs));
}
// Uncertainty reports, never hides.
wpj_assert('an unknown function is not core', false, wpj_callback_is_core('wpj_t_no_such_function', $core_dirs));
wpj_assert('an unknown method is not core', false, wpj_callback_is_core(array('WPJ_T_Core', 'nope'), $core_dirs));
wpj_assert('a PHP built-in has no file, so is not core', false, wpj_callback_is_core('strlen', $core_dirs));
wpj_assert('a non-callable shape is not core', false, wpj_callback_is_core(42, $core_dirs));
// A REAL sibling directory whose name prefixes the core one. If it did not exist, realpath()
// would return false and the test would pass without ever reaching the separator guard.
$sibling_root = sys_get_temp_dir() . '/wpj-sibling-' . getmypid();
@mkdir($sibling_root . '/wp-incl', 0777, true);
@mkdir($sibling_root . '/wp-includes', 0777, true);
file_put_contents($sibling_root . '/wp-includes/sibling-callback.php', "<?php\nfunction wpj_t_sibling_fn() {}\n");
require $sibling_root . '/wp-includes/sibling-callback.php';
wpj_assert('precondition: the sibling directory really exists', true, is_dir($sibling_root . '/wp-incl'));
wpj_assert('a sibling directory sharing the prefix is not core', false,
    wpj_callback_is_core('wpj_t_sibling_fn', array($sibling_root . '/wp-incl')));
wpj_assert('the same file IS core under its own directory', true,
    wpj_callback_is_core('wpj_t_sibling_fn', array($sibling_root . '/wp-includes')));
unlink($sibling_root . '/wp-includes/sibling-callback.php');
rmdir($sibling_root . '/wp-includes');
rmdir($sibling_root . '/wp-incl');
rmdir($sibling_root);

$by_hook = array(
    'core_only' => array('wpj_t_core_fn', array('WPJ_T_Core', 'stat')),
    'leftover' => array('wpj_t_leftover_fn'),
    'mixed' => array('wpj_t_core_fn', 'wpj_t_leftover_fn'),
);
wpj_assert(
    'only a hook whose every callback is core is core; mixed and leftover are not; unhandled is not',
    array('core_only'),
    wpj_snapshot_core_hooks(array('core_only', 'leftover', 'mixed', 'unhandled'), $by_hook, $core_dirs)
);

// Whether the plugin under test is still active, by slug, from active_plugins.
wpj_assert('a directory plugin is active', true, wpj_plugin_slug_active('acme', array('other/other.php', 'acme/acme.php')));
wpj_assert('a single-file plugin is active', true, wpj_plugin_slug_active('hello', array('hello.php')));
wpj_assert('a slug that only prefixes another is not active', false, wpj_plugin_slug_active('acme', array('acme-pro/acme-pro.php')));
wpj_assert('an absent plugin is not active', false, wpj_plugin_slug_active('acme', array()));
wpj_assert('a non-array option is read as nothing active', false, wpj_plugin_slug_active('acme', false));

// The field is OMITTED when no plugin was asked about: absent means unknown to the runner, and
// `false` would claim the plugin is known to be inactive.
wpj_assert('no slug, no pluginActive field', array(), wpj_plugin_active_field('', array('acme/acme.php')));
wpj_assert('a slug reports its state', array('pluginActive' => true), wpj_plugin_active_field('acme', array('acme/acme.php')));
wpj_assert('an inactive slug reports false', array('pluginActive' => false), wpj_plugin_active_field('acme', array()));

wpj_assert_exit();
