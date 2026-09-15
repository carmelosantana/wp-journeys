<?php
require __DIR__ . '/assert.php';
require __DIR__ . '/../../mu-plugin/src/logtail.php';

/** Remove a temp tree, restoring permissions first so a chmod-0000 entry cannot survive. */
function wpj_test_rmtree($p) {
    if (is_dir($p) && !is_link($p)) {
        chmod($p, 0700);
        foreach (scandir($p) as $entry) {
            if ($entry !== '.' && $entry !== '..') { wpj_test_rmtree($p . '/' . $entry); }
        }
        rmdir($p);
    } elseif (file_exists($p) || is_link($p)) {
        chmod($p, 0600);
        unlink($p);
    }
}

// A private scratch directory for the temp logs, removed at shutdown even if a test dies partway.
$dir = sys_get_temp_dir() . '/wpj-logtail-' . getmypid();
mkdir($dir);
register_shutdown_function('wpj_test_rmtree', $dir);
$path = $dir . '/debug.log';

// Root reads and writes any file whatever its mode, so the permission tests cannot mean anything.
$as_root = function_exists('posix_geteuid') && posix_geteuid() === 0;

// --- where the log is: core's own rule from wp_debug_mode() -------------------------------

wpj_assert('WP_DEBUG_LOG true logs to wp-content/debug.log', '/wp/wp-content/debug.log', wpj_log_path(true, '/wp/wp-content'));
wpj_assert('WP_DEBUG_LOG "1" means the default path, not a file named "1"', '/wp/wp-content/debug.log', wpj_log_path('1', '/wp/wp-content'));
wpj_assert('WP_DEBUG_LOG "TRUE" means the default path, as core reads it', '/wp/wp-content/debug.log', wpj_log_path('TRUE', '/wp/wp-content'));
wpj_assert('WP_DEBUG_LOG as a path logs there', '/var/log/wp.log', wpj_log_path('/var/log/wp.log', '/wp/wp-content'));
wpj_assert('WP_DEBUG_LOG false means no log', '', wpj_log_path(false, '/wp/wp-content'));
wpj_assert('WP_DEBUG_LOG "" means no log', '', wpj_log_path('', '/wp/wp-content'));
wpj_assert('WP_DEBUG_LOG "0" means no log: core skips a falsy path, it is not a file named "0"', '', wpj_log_path('0', '/wp/wp-content'));

// --- logging off: the signal is lost, and says so ------------------------------------------

file_put_contents($path, "[15-Sep-2026 22:00:00 UTC] PHP Notice:  x in /x.php on line 1\n");
wpj_assert(
    'logging off is a lost signal with a reason, echoing the caller\'s offset, never an empty delta',
    array('offset' => 545, 'lines' => array(), 'available' => false, 'reason' => 'WP_DEBUG_LOG is off'),
    wpj_log_tail($path, false, 545)
);
wpj_assert('a lost signal echoes the offset clamped at 0', 0, wpj_log_tail($path, false, -7)['offset']);
unlink($path);

// --- a missing file: available only if the web process can create it ---------------------

wpj_assert(
    'a missing file in a writable directory is available with zero lines at offset 0 (WordPress creates it lazily)',
    array('offset' => 0, 'lines' => array(), 'available' => true),
    wpj_log_tail($path, true, 0)
);
$absent = wpj_log_tail($dir . '/absent/debug.log', true, 0);
wpj_assert('a missing file whose directory is absent is not available (it can never fill)', false, $absent['available']);
wpj_assert('a missing file whose directory is absent carries a reason', 'debug.log does not exist and the web server cannot create it', $absent['reason']);

// --- a normal delta: read the offset, write, read only what is new -------------------------

file_put_contents($path, "old line\n");
$before = wpj_log_tail($path, true, 0);
wpj_assert('the first read returns the whole file', array('old line'), $before['lines']);
wpj_assert('the first read returns the offset at the end of the file', 9, $before['offset']);

file_put_contents($path, "new line\n\nanother\n", FILE_APPEND);
$delta = wpj_log_tail($path, true, $before['offset']);
wpj_assert('a read from a mid-file offset returns only the new, non-blank lines', array('new line', 'another'), $delta['lines']);
wpj_assert('the returned offset covers exactly the bytes returned', 27, $delta['offset']);
wpj_assert('a delta is available', true, $delta['available']);

wpj_assert(
    'a second read at the returned offset returns zero lines',
    array('offset' => 27, 'lines' => array(), 'available' => true),
    wpj_log_tail($path, true, $delta['offset'])
);

// --- a partial trailing line is left for the next read -------------------------------------

file_put_contents($path, "a\npart");
wpj_assert(
    'a line still being written is not returned, and the offset stops before it',
    array('offset' => 2, 'lines' => array('a'), 'available' => true),
    wpj_log_tail($path, true, 0)
);
file_put_contents($path, "ial\n", FILE_APPEND);
wpj_assert(
    'the next read returns the completed line once, whole',
    array('offset' => 10, 'lines' => array('partial'), 'available' => true),
    wpj_log_tail($path, true, 2)
);

// --- the size-only baseline ----------------------------------------------------------------

wpj_assert(
    '"end" returns the current size and no lines, without reading the log',
    array('offset' => 10, 'lines' => array(), 'available' => true),
    wpj_log_tail($path, true, 'end')
);
wpj_assert('"end" with logging off is lost, not a clean baseline', false, wpj_log_tail($path, false, 'end')['available']);
unlink($path);
wpj_assert(
    '"end" on a missing file in a writable directory is offset 0',
    array('offset' => 0, 'lines' => array(), 'available' => true),
    wpj_log_tail($path, true, 'end')
);

// --- an offset past EOF: the log was rotated or truncated ----------------------------------

file_put_contents($path, "fresh\n");
wpj_assert(
    'an offset past EOF restarts at 0 and returns the whole file, not silent nothing',
    array('offset' => 6, 'lines' => array('fresh'), 'available' => true),
    wpj_log_tail($path, true, 500)
);

// --- permissions: an unreadable or unwritable log is lost, with a reason -------------------

if ($as_root) {
    echo "skip permission tests: running as uid 0, which reads and writes any file whatever its mode\n";
} else {
    chmod($path, 0000);
    clearstatcache();
    wpj_assert('precondition: chmod 0000 makes the file unreadable to this user', false, is_readable($path));
    $unreadable = wpj_log_tail($path, true, 3);
    wpj_assert('an unreadable file is not available', false, $unreadable['available']);
    wpj_assert('an unreadable file carries a reason', 'debug.log is not readable', $unreadable['reason']);
    wpj_assert('an unreadable file returns no lines', array(), $unreadable['lines']);
    wpj_assert('an unreadable file echoes the caller\'s offset', 3, $unreadable['offset']);

    chmod($path, 0444);
    clearstatcache();
    $unwritable = wpj_log_tail($path, true, 0);
    wpj_assert('a readable file the web server cannot write is not available (it can never fill)', false, $unwritable['available']);
    wpj_assert('an unwritable file carries a reason', 'debug.log is not writable by the web server', $unwritable['reason']);
    chmod($path, 0600);

    $locked = $dir . '/locked';
    mkdir($locked, 0555);
    clearstatcache();
    $uncreatable = wpj_log_tail($locked . '/debug.log', true, 0);
    wpj_assert('a missing file in an unwritable directory is not available', false, $uncreatable['available']);
    wpj_assert('a missing file in an unwritable directory carries a reason', 'debug.log does not exist and the web server cannot create it', $uncreatable['reason']);
}

wpj_assert_exit();
