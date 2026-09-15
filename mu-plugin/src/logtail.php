<?php
/**
 * Return the debug.log bytes written since a caller-supplied offset.
 *
 * The runner reads the offset before a request and the delta after it, so a diagnostic is
 * attributed to the request that produced it. If the log cannot be read the response says
 * so EXPLICITLY (`available: false` plus a reason) — it never returns an empty delta, which
 * would look identical to "nothing went wrong" and is exactly the false green this project
 * exists to prevent.
 *
 * The logic takes the path and the WP_DEBUG_LOG state as parameters so it is tested without
 * WordPress; wpj_log_delta() is the thin wrapper that reads the constants.
 */

/** The live site's delta: WordPress's constants in, wpj_log_tail() out. */
function wpj_log_delta($offset) {
    $path = wpj_log_path(defined('WP_DEBUG_LOG') ? WP_DEBUG_LOG : false, WP_CONTENT_DIR);
    return wpj_log_tail($path, $path !== '', $offset);
}

/**
 * Where WordPress writes its log, by core's own rule in wp_debug_mode().
 *
 * @param mixed  $debug_log   the WP_DEBUG_LOG constant's value
 * @param string $content_dir WP_CONTENT_DIR
 * @return string the log path, or '' when logging is off
 */
function wpj_log_path($debug_log, $content_dir) {
    // Core reads "1" and "true" (any case) as the default path, not as a file with that name.
    if (in_array(strtolower((string) $debug_log), array('true', '1'), true)) {
        return $content_dir . '/debug.log';
    }
    return is_string($debug_log) ? $debug_log : '';
}

/**
 * @param string $path    the log file
 * @param bool   $enabled whether WP_DEBUG_LOG is on
 * @param mixed  $offset  the byte offset a previous call returned
 * @return array{offset:int, lines:string[], available:bool, reason?:string}
 */
function wpj_log_tail($path, $enabled, $offset) {
    if (!$enabled) {
        return wpj_log_lost('WP_DEBUG_LOG is off');
    }
    if (!file_exists($path)) {
        // Not an error: WordPress creates the file lazily on the first diagnostic.
        return array('offset' => 0, 'lines' => array(), 'available' => true);
    }
    if (!is_readable($path)) {
        return wpj_log_lost('debug.log is not readable');
    }

    $size = filesize($path);
    $offset = max(0, (int) $offset);
    // A smaller file than last time means the log was rotated or truncated; restart at 0
    // rather than seeking past the end and silently reporting nothing.
    if ($offset > $size) { $offset = 0; }

    $handle = fopen($path, 'rb');
    if ($handle === false) {
        return wpj_log_lost('debug.log could not be opened');
    }
    fseek($handle, $offset);
    $chunk = stream_get_contents($handle);
    fclose($handle);

    $lines = $chunk === '' ? array() : preg_split('/\r\n|\n|\r/', $chunk);
    $lines = array_values(array_filter((array) $lines, function ($l) { return trim($l) !== ''; }));

    return array('offset' => $size, 'lines' => $lines, 'available' => true);
}

/** The signal is lost: say so, with a reason, rather than return an empty delta. */
function wpj_log_lost($reason) {
    return array('offset' => 0, 'lines' => array(), 'available' => false, 'reason' => $reason);
}
