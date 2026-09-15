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

    return array(
        'options' => $options,
        'tables' => $tables,
        'cron' => wpj_snapshot_cron_hooks(_get_cron_array()),
        'userMeta' => $meta_keys,
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
