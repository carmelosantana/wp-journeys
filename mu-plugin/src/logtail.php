<?php
/**
 * Return the debug.log bytes written since a caller-supplied offset.
 *
 * The runner reads the offset before a request and the delta after it, so a diagnostic is
 * attributed to the request that produced it. If the log cannot be read — or can never fill —
 * the response says so EXPLICITLY (`available: false` plus a reason). It never returns an
 * empty delta for a lost signal, which would look identical to "nothing went wrong" and is
 * exactly the false green this project exists to prevent.
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
    // Core logs only to a truthy path (`if ( $log_path )`), so "" and "0" mean off.
    return (is_string($debug_log) && $debug_log) ? $debug_log : '';
}

/**
 * @param string     $path    the log file
 * @param bool       $enabled whether WP_DEBUG_LOG is on
 * @param int|string $offset  the byte offset a previous call returned, or 'end' for a
 *                            size-only baseline that reads nothing
 * @return array{offset:int, lines:string[], available:bool, reason?:string}
 */
function wpj_log_tail($path, $enabled, $offset) {
    $baseline = $offset === 'end';
    $offset = $baseline ? 0 : max(0, (int) $offset);

    if (!$enabled) {
        return wpj_log_lost('WP_DEBUG_LOG is off', $offset);
    }
    if (!file_exists($path)) {
        // WordPress creates the file lazily on the first diagnostic — but only if it can.
        if (is_dir(dirname($path)) && is_writable(dirname($path))) {
            return array('offset' => 0, 'lines' => array(), 'available' => true);
        }
        return wpj_log_lost('debug.log does not exist and the web server cannot create it', $offset);
    }
    if (!is_readable($path)) {
        return wpj_log_lost('debug.log is not readable', $offset);
    }
    if (!is_writable($path)) {
        return wpj_log_lost('debug.log is not writable by the web server', $offset);
    }

    $handle = fopen($path, 'rb');
    if ($handle === false) {
        return wpj_log_lost('debug.log could not be opened', $offset);
    }
    // fstat() on the open handle, not filesize(): it is never stat-cached.
    $stat = fstat($handle);
    if ($stat === false) {
        fclose($handle);
        return wpj_log_lost('debug.log size could not be read', $offset);
    }
    $size = (int) $stat['size'];
    if ($baseline) {
        fclose($handle);
        return array('offset' => $size, 'lines' => array(), 'available' => true);
    }

    // A smaller file than last time means the log was rotated or truncated; restart at 0
    // rather than seeking past the end and silently reporting nothing.
    $start = $offset > $size ? 0 : $offset;
    if (fseek($handle, $start) !== 0) {
        fclose($handle);
        return wpj_log_lost('debug.log could not be seeked', $offset);
    }
    $chunk = stream_get_contents($handle);
    fclose($handle);
    if ($chunk === false) {
        return wpj_log_lost('debug.log could not be read', $offset);
    }

    // Only complete lines. A line still being written is left for the next read, so it is
    // returned once, whole, and the offset covers exactly the bytes returned.
    $last_newline = strrpos($chunk, "\n");
    $complete = $last_newline === false ? '' : substr($chunk, 0, $last_newline + 1);

    $lines = $complete === '' ? array() : preg_split('/\r\n|\n|\r/', $complete);
    $lines = array_values(array_filter((array) $lines, function ($l) { return trim($l) !== ''; }));

    return array('offset' => $start + strlen($complete), 'lines' => $lines, 'available' => true);
}

/**
 * The signal is lost: say so, with a reason, rather than return an empty delta. The caller's
 * offset is echoed back; the runner must re-baseline, not resume from it.
 */
function wpj_log_lost($reason, $offset) {
    return array('offset' => $offset, 'lines' => array(), 'available' => false, 'reason' => $reason);
}
