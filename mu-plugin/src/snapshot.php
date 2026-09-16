<?php
/**
 * Name-only snapshot of WordPress's persistent state.
 *
 * Names, never values: the runner compares presence to find orphans, and dumping option
 * values off a real site would drag credentials through the wire for no benefit.
 */
function wpj_snapshot() {
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
        'cronHandled' => wpj_snapshot_handled_hooks($cron, 'has_action'),
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
 * The scheduled hooks some code loaded in THIS request still answers.
 *
 * The runner's origin re-check for a cron event that appeared during a run: after the uninstall
 * the plugin under test is not loaded, so a hook with a callback belongs to core or to another
 * active plugin. Core schedules some of its own events lazily, and without this a run whose
 * baseline predated that write blamed it on the plugin under test.
 *
 * @param string[] $hooks       hook names, as wpj_snapshot_cron_hooks() returns them
 * @param callable $has_action  function (string $hook): bool|int — has_action in production
 * @return string[]
 */
function wpj_snapshot_handled_hooks(array $hooks, $has_action) {
    $handled = array();
    foreach ($hooks as $hook) {
        if (call_user_func($has_action, $hook)) {
            $handled[] = $hook;
        }
    }
    return $handled;
}
