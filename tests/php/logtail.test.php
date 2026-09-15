<?php
require __DIR__ . '/assert.php';
require __DIR__ . '/../../mu-plugin/src/logtail.php';

// A private scratch directory for the temp logs, removed at the end.
$dir = sys_get_temp_dir() . '/wpj-logtail-' . getmypid();
mkdir($dir);
$path = $dir . '/debug.log';

// --- where the log is: core's own rule from wp_debug_mode() -------------------------------

wpj_assert('WP_DEBUG_LOG true logs to wp-content/debug.log', '/wp/wp-content/debug.log', wpj_log_path(true, '/wp/wp-content'));
wpj_assert('WP_DEBUG_LOG "1" means the default path, not a file named "1"', '/wp/wp-content/debug.log', wpj_log_path('1', '/wp/wp-content'));
wpj_assert('WP_DEBUG_LOG "TRUE" means the default path, as core reads it', '/wp/wp-content/debug.log', wpj_log_path('TRUE', '/wp/wp-content'));
wpj_assert('WP_DEBUG_LOG as a path logs there', '/var/log/wp.log', wpj_log_path('/var/log/wp.log', '/wp/wp-content'));
wpj_assert('WP_DEBUG_LOG false means no log', '', wpj_log_path(false, '/wp/wp-content'));
wpj_assert('WP_DEBUG_LOG "" means no log', '', wpj_log_path('', '/wp/wp-content'));

// --- logging off: the signal is lost, and says so ------------------------------------------

file_put_contents($path, "[15-Sep-2026 22:00:00 UTC] PHP Notice:  x in /x.php on line 1\n");
wpj_assert(
    'logging off is a lost signal with a reason, never an empty delta',
    array('offset' => 0, 'lines' => array(), 'available' => false, 'reason' => 'WP_DEBUG_LOG is off'),
    wpj_log_tail($path, false, 0)
);
unlink($path);

// --- a missing file: available, nothing yet ------------------------------------------------

wpj_assert(
    'a missing file is available with zero lines at offset 0 (WordPress creates it lazily)',
    array('offset' => 0, 'lines' => array(), 'available' => true),
    wpj_log_tail($path, true, 0)
);

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

// --- an offset past EOF: the log was rotated or truncated ----------------------------------

file_put_contents($path, "fresh\n");
wpj_assert(
    'an offset past EOF restarts at 0 and returns the whole file, not silent nothing',
    array('offset' => 6, 'lines' => array('fresh'), 'available' => true),
    wpj_log_tail($path, true, 500)
);

// --- an unreadable file: lost, with a reason -----------------------------------------------

chmod($path, 0000);
clearstatcache();
wpj_assert('precondition: chmod 0000 makes the file unreadable to this user', false, is_readable($path));
$unreadable = wpj_log_tail($path, true, 0);
wpj_assert('an unreadable file is not available', false, $unreadable['available']);
wpj_assert('an unreadable file carries a reason', 'debug.log is not readable', $unreadable['reason']);
wpj_assert('an unreadable file returns no lines', array(), $unreadable['lines']);
chmod($path, 0600);

unlink($path);
rmdir($dir);

wpj_assert_exit();
