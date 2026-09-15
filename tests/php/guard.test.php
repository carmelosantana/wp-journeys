<?php
require __DIR__ . '/assert.php';
require __DIR__ . '/../../mu-plugin/src/guard.php';

$ok = array('enabled' => true, 'environment_type' => 'local', 'wp_debug' => true, 'has_secret' => true);

wpj_assert('a fully configured local site is allowed', '', wpj_guard_verdict($ok));

wpj_assert(
    'refuses when not explicitly enabled',
    'WPJ_AGENT is not enabled',
    wpj_guard_verdict(array_merge($ok, array('enabled' => false)))
);
wpj_assert(
    'refuses on a production environment type',
    'refusing to run with environment_type "production"',
    wpj_guard_verdict(array_merge($ok, array('environment_type' => 'production')))
);
wpj_assert(
    'refuses on staging too',
    'refusing to run with environment_type "staging"',
    wpj_guard_verdict(array_merge($ok, array('environment_type' => 'staging')))
);
wpj_assert(
    'allows development alongside local',
    '',
    wpj_guard_verdict(array_merge($ok, array('environment_type' => 'development')))
);
wpj_assert(
    'refuses when WP_DEBUG is off',
    'WP_DEBUG is off',
    wpj_guard_verdict(array_merge($ok, array('wp_debug' => false)))
);
wpj_assert(
    'refuses when no shared secret is configured',
    'no shared secret is configured',
    wpj_guard_verdict(array_merge($ok, array('has_secret' => false)))
);
wpj_assert(
    'an unknown environment type is refused, not defaulted open',
    'refusing to run with environment_type ""',
    wpj_guard_verdict(array_merge($ok, array('environment_type' => '')))
);
wpj_assert(
    'a missing key is refused rather than treated as true',
    'WPJ_AGENT is not enabled',
    wpj_guard_verdict(array())
);
wpj_assert(
    'enabled as the string "false" is refused, not coerced to true',
    'WPJ_AGENT is not enabled',
    wpj_guard_verdict(array_merge($ok, array('enabled' => 'false')))
);
wpj_assert(
    'enabled as the string "1" is refused; only boolean true counts',
    'WPJ_AGENT is not enabled',
    wpj_guard_verdict(array_merge($ok, array('enabled' => '1')))
);
wpj_assert(
    'enabled as the int 1 is refused; only boolean true counts',
    'WPJ_AGENT is not enabled',
    wpj_guard_verdict(array_merge($ok, array('enabled' => 1)))
);
wpj_assert(
    'wp_debug as the int 1 is refused; only boolean true counts',
    'WP_DEBUG is off',
    wpj_guard_verdict(array_merge($ok, array('wp_debug' => 1)))
);

wpj_assert_exit();
