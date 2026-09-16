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

// The origin re-check: which scheduled hooks some loaded code still answers. Asked of an
// injected predicate so this stays pure; the live call passes has_action.
$handled = function ($hook) { return $hook === 'wp_version_check'; };
wpj_assert(
    'keeps only the hooks the predicate says are handled, in order',
    array('wp_version_check'),
    wpj_snapshot_handled_hooks(array('acme_daily', 'acme_sync', 'wp_version_check'), $handled)
);
wpj_assert('no hooks, none handled', array(), wpj_snapshot_handled_hooks(array(), $handled));

wpj_assert_exit();
