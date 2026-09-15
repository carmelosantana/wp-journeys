<?php
require __DIR__ . '/assert.php';
require __DIR__ . '/../../mu-plugin/src/actors.php';

// --- which roles the runner provisions -----------------------------------------------------

wpj_assert(
    'the runner provisions the five core roles, least-privileged first, and never anonymous',
    array('subscriber', 'contributor', 'author', 'editor', 'administrator'),
    wpj_actor_roles()
);

// --- the login and email an actor owns -----------------------------------------------------

wpj_assert('an actor role names the user wpj_<role>', 'wpj_editor', wpj_actor_login('editor'));
wpj_assert('an actor role names the user wpj_<role>', 'wpj_subscriber', wpj_actor_login('subscriber'));
wpj_assert('anonymous has no user: it is the actor without a login', '', wpj_actor_login('anonymous'));
wpj_assert('an unknown role names no user', '', wpj_actor_login('superadmin'));
wpj_assert('role matching is exact, not case-insensitive', '', wpj_actor_login('Editor'));
wpj_assert('a padded role names no user', '', wpj_actor_login(' editor'));
wpj_assert('an empty role names no user', '', wpj_actor_login(''));

wpj_assert(
    'an actor mail address is on the reserved .invalid TLD, so it can never be delivered',
    'wpj_editor@wp-journeys.invalid',
    wpj_actor_email('editor')
);
wpj_assert('an unknown role has no mail address', '', wpj_actor_email('superadmin'));

// --- telling the runner's own users apart from the site's real ones ------------------------

wpj_assert(
    'a user whose login and mail are both the runner\'s is that actor',
    'editor',
    wpj_actor_role_for('wpj_editor', 'wpj_editor@wp-journeys.invalid')
);
wpj_assert(
    'the site\'s real administrator is not an actor',
    '',
    wpj_actor_role_for('admin', 'admin@example.com')
);
wpj_assert(
    'a user carrying the runner\'s login but somebody else\'s mail is NOT an actor: the name alone is guessable',
    '',
    wpj_actor_role_for('wpj_editor', 'boss@example.com')
);
wpj_assert(
    'the runner\'s prefix on a role it does not provision is not an actor',
    '',
    wpj_actor_role_for('wpj_superadmin', 'wpj_superadmin@wp-journeys.invalid')
);
wpj_assert(
    'a mail address belonging to a different actor is not a match',
    '',
    wpj_actor_role_for('wpj_editor', 'wpj_author@wp-journeys.invalid')
);
wpj_assert('an empty login is not an actor', '', wpj_actor_role_for('', ''));

// --- the one-time login token ---------------------------------------------------------------

wpj_assert('a 32-character alphanumeric token is well-formed', true, wpj_login_token_valid(str_repeat('a1B2', 8)));
wpj_assert('a short token is refused', false, wpj_login_token_valid(str_repeat('a', 31)));
wpj_assert('a long token is refused', false, wpj_login_token_valid(str_repeat('a', 33)));
wpj_assert('an empty token is refused', false, wpj_login_token_valid(''));
wpj_assert('a token carrying punctuation is refused', false, wpj_login_token_valid(str_repeat('a', 31) . '-'));
// PHP's $ matches before a trailing newline, so an anchored /^...$/ would accept this one.
wpj_assert('a token with a trailing newline is refused', false, wpj_login_token_valid(str_repeat('a', 32) . "\n"));
wpj_assert('a non-string token is refused', false, wpj_login_token_valid(array()));

$token = str_repeat('a1B2', 8);
$key = wpj_login_token_key($token);
wpj_assert(
    'the token is stored under its hash, never in the clear: a database reader cannot replay it',
    'wpj_login_' . hash('sha256', $token),
    $key
);
wpj_assert('the storage key does not contain the token', false, strpos($key, $token) !== false);
wpj_assert(
    'a different token gets a different key',
    false,
    wpj_login_token_key($token) === wpj_login_token_key(str_repeat('b3C4', 8))
);
wpj_assert(
    'the key fits WordPress\'s 172-character transient name limit',
    true,
    strlen($key) <= 172
);

wpj_assert_exit();
