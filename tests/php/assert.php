<?php
/** The one assertion helper the plain-PHP tests share. Exit with wpj_assert_exit(). */

$fails = 0;

function wpj_assert($label, $expected, $actual) {
    global $fails;
    if ($expected === $actual) { echo "ok   $label\n"; return; }
    $fails++;
    echo "FAIL $label\n  expected: " . var_export($expected, true) . "\n  actual:   " . var_export($actual, true) . "\n";
}

function wpj_assert_exit() {
    global $fails;
    exit($fails === 0 ? 0 : 1);
}
