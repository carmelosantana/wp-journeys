<?php
/**
 * Name-only snapshot of WordPress's persistent state.
 *
 * Names, never values: the runner compares presence to find orphans, and dumping option
 * values off a real site would drag credentials through the wire for no benefit.
 */
function wpj_snapshot($plugin = '') {
    global $wpdb;

    $options = $wpdb->get_col("SELECT option_name FROM {$wpdb->options}");
    $tables = $wpdb->get_col('SHOW TABLES');
    $meta_keys = $wpdb->get_col("SELECT DISTINCT meta_key FROM {$wpdb->usermeta}");

    sort($options); sort($tables); sort($meta_keys);

    $cron = wpj_snapshot_cron_hooks(_get_cron_array());
    return array(
        'options' => $options,
        'tables' => $tables,
        'cron' => $cron,
        'userMeta' => $meta_keys,
        'cronCore' => wpj_snapshot_core_hooks($cron, wpj_snapshot_callbacks_by_hook($cron), wpj_core_dirs()),
        'pluginActive' => wpj_plugin_slug_active((string) $plugin, get_option('active_plugins')),
    );
}

/**
 * Every scheduled hook's name, once each and sorted.
 *
 * @param array|false $cron what _get_cron_array() returns: timestamp -> hook -> signature -> event
 * @return string[]
 */
function wpj_snapshot_cron_hooks($cron) {
    $hooks = array();
    // is_array(), not an (array) cast: (array) false is array(false), a phantom hook "0".
    foreach (is_array($cron) ? $cron : array() as $events) {
        foreach (is_array($events) ? $events : array() as $hook => $_) {
            $hooks[$hook] = true;
        }
    }
    // array_keys() turns a numeric-string key back into an int; the runner expects names.
    $hooks = array_map('strval', array_keys($hooks));
    sort($hooks);
    return $hooks;
}

/**
 * The directories core's own code lives in. Nothing else counts as core: not wp-content, not an
 * mu-plugin, not a drop-in.
 *
 * @return string[]
 */
function wpj_core_dirs() {
    return array(ABSPATH . WPINC, ABSPATH . 'wp-admin');
}

/**
 * Every callback registered on each hook in THIS request, flattened across priorities.
 *
 * @param string[] $hooks
 * @return array hook => list of callbacks
 */
function wpj_snapshot_callbacks_by_hook(array $hooks) {
    global $wp_filter;
    $by_hook = array();
    foreach ($hooks as $hook) {
        $callbacks = array();
        if (isset($wp_filter[$hook]) && is_object($wp_filter[$hook]) && isset($wp_filter[$hook]->callbacks)) {
            foreach ((array) $wp_filter[$hook]->callbacks as $at_priority) {
                foreach ((array) $at_priority as $entry) {
                    if (is_array($entry) && array_key_exists('function', $entry)) {
                        $callbacks[] = $entry['function'];
                    }
                }
            }
        }
        $by_hook[$hook] = $callbacks;
    }
    return $by_hook;
}

/**
 * The scheduled hooks that ONLY core answers (R79).
 *
 * The runner's origin re-check for a cron event that appeared during a run. Core schedules some
 * of its own events lazily (wp_delete_temp_updater_backups, observed on wpjtest), and a run
 * whose baseline predated that write blamed it on the plugin under test. But "something answers
 * it" is not "core answers it": a plugin that leaves an mu-plugin or drop-in behind still
 * handles its own orphaned hook after the uninstall. So a hook is core's only when it has at
 * least one callback and EVERY callback is defined under a core directory.
 *
 * @param string[] $hooks
 * @param array    $callbacks_by_hook hook => list of callbacks
 * @param string[] $core_dirs
 * @return string[]
 */
function wpj_snapshot_core_hooks(array $hooks, array $callbacks_by_hook, array $core_dirs) {
    $core = array();
    foreach ($hooks as $hook) {
        $callbacks = isset($callbacks_by_hook[$hook]) ? (array) $callbacks_by_hook[$hook] : array();
        if (empty($callbacks)) {
            continue;
        }
        $all_core = true;
        foreach ($callbacks as $callback) {
            if (!wpj_callback_is_core($callback, $core_dirs)) {
                $all_core = false;
                break;
            }
        }
        if ($all_core) {
            $core[] = $hook;
        }
    }
    return $core;
}

/**
 * Whether a callback is DEFINED in a file under one of $core_dirs. Anything that cannot be
 * resolved to a file — an unknown name, a PHP built-in, an odd shape — is not core: uncertainty
 * must report the hook, never hide it.
 *
 * @param mixed    $callback  a function name, 'Class::method', [object|class, method], a closure
 *                            or an invokable object
 * @param string[] $core_dirs
 * @return bool
 */
function wpj_callback_is_core($callback, array $core_dirs) {
    $file = wpj_callback_file($callback);
    if ($file === '') {
        return false;
    }
    foreach ($core_dirs as $dir) {
        $root = realpath($dir);
        if ($root === false) {
            continue;
        }
        $root = rtrim($root, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;
        if (strpos($file, $root) === 0) {
            return true;
        }
    }
    return false;
}

/**
 * The real path of the file a callback is defined in, or '' when it cannot be told.
 *
 * @param mixed $callback
 * @return string
 */
function wpj_callback_file($callback) {
    try {
        if ($callback instanceof Closure) {
            $reflector = new ReflectionFunction($callback);
        } elseif (is_string($callback) && strpos($callback, '::') !== false) {
            $parts = explode('::', $callback, 2);
            $reflector = new ReflectionMethod($parts[0], $parts[1]);
        } elseif (is_string($callback)) {
            if (!function_exists($callback)) {
                return '';
            }
            $reflector = new ReflectionFunction($callback);
        } elseif (is_array($callback) && count($callback) === 2 && isset($callback[0], $callback[1])
            && (is_object($callback[0]) || is_string($callback[0])) && is_string($callback[1])) {
            $reflector = new ReflectionMethod($callback[0], $callback[1]);
        } elseif (is_object($callback) && method_exists($callback, '__invoke')) {
            $reflector = new ReflectionMethod($callback, '__invoke');
        } else {
            return '';
        }
    } catch (ReflectionException $e) {
        return '';
    }
    $file = $reflector->getFileName();
    if (!is_string($file) || $file === '') {
        return '';
    }
    $real = realpath($file);
    return $real === false ? '' : $real;
}

/**
 * Whether the plugin with directory (or single-file) slug $slug is in active_plugins.
 *
 * @param string $slug
 * @param mixed  $active_plugins the active_plugins option as stored
 * @return bool
 */
function wpj_plugin_slug_active($slug, $active_plugins) {
    if ($slug === '' || !is_array($active_plugins)) {
        return false;
    }
    foreach ($active_plugins as $file) {
        $file = (string) $file;
        if (strpos($file, $slug . '/') === 0 || $file === $slug . '.php') {
            return true;
        }
    }
    return false;
}
