<?php
/**
 * The runner's own WordPress users, and the one-time URL that logs a browser in as one.
 *
 * Two rules shape this file:
 *
 * 1. The runner touches ONLY users it created. An actor is identified by its login AND its
 *    reserved-.invalid mail address together; a user that merely carries the login — a real
 *    person who happened to be called `wpj_editor` — is refused rather than adopted,
 *    provisioned over, or logged into.
 * 2. A minted token is live auth material. It is stored only as a SHA-256 hash, spent by the
 *    one request that actually deletes its row, and never written to a log.
 *
 * The naming and token rules are pure, so they are tested without WordPress; the functions
 * that read and write the database are thin wrappers over them.
 */

/**
 * The roles the runner provisions, least-privileged first.
 * `anonymous` is deliberately absent: it is the one actor with no user.
 */
function wpj_actor_roles() {
    return array('subscriber', 'contributor', 'author', 'editor', 'administrator');
}

/** The login the runner owns for a role, or '' for a role it does not provision. */
function wpj_actor_login($role) {
    return in_array($role, wpj_actor_roles(), true) ? 'wpj_' . $role : '';
}

/**
 * The mail address the runner owns for a role, or '' for a role it does not provision.
 * `.invalid` is reserved by RFC 2606, so nothing addressed to an actor can ever be delivered.
 */
function wpj_actor_email($role) {
    $login = wpj_actor_login($role);
    return $login === '' ? '' : $login . '@wp-journeys.invalid';
}

/**
 * The role this user is the runner's actor for, or '' when the user is not one of ours.
 *
 * Both halves must match. The login alone is guessable, and treating a guessable name as
 * proof of ownership would let the agent provision over — or mint a login for — a real user.
 *
 * @param string $login a user's user_login
 * @param string $email that user's user_email
 * @return string the actor role, or '' for any user the runner does not own
 */
function wpj_actor_role_for($login, $email) {
    foreach (wpj_actor_roles() as $role) {
        if ($login === wpj_actor_login($role) && $email === wpj_actor_email($role)) {
            return $role;
        }
    }
    return '';
}

/**
 * Exactly 32 alphanumerics.
 * Anchored with \A and \z, because PHP's $ also matches immediately before a trailing newline.
 */
function wpj_login_token_valid($token) {
    return is_string($token) && preg_match('/\A[A-Za-z0-9]{32}\z/', $token) === 1;
}

/**
 * Where a token's user id is stored: the token's hash, never the token itself, so reading the
 * options table does not hand anyone a usable login.
 */
function wpj_login_token_key($token) {
    return 'wpj_login_' . hash('sha256', (string) $token);
}

/**
 * Create, or find, the runner's user for a role. Idempotent: the same call returns the same id.
 *
 * @param string $role one of wpj_actor_roles()
 * @return array{userId:int}|WP_Error
 */
function wpj_ensure_actor($role) {
    $login = wpj_actor_login($role);
    if ($login === '') {
        return new WP_Error(
            'wpj_bad_role',
            sprintf('unknown actor role "%s"', is_string($role) ? $role : gettype($role)),
            array('status' => 400)
        );
    }

    $user = get_user_by('login', $login);
    if ($user) {
        if (wpj_actor_role_for($user->user_login, $user->user_email) !== $role) {
            return new WP_Error(
                'wpj_actor_conflict',
                sprintf('a user named "%s" exists that the runner did not create; refusing to touch it', $login),
                array('status' => 409)
            );
        }
        // A plugin under test can change a role out from under us, and a journey that claims
        // to run as a subscriber must actually run as one.
        if (array_values((array) $user->roles) !== array($role)) {
            $user->set_role($role);
        }
        return array('userId' => (int) $user->ID);
    }

    $id = wp_insert_user(array(
        'user_login' => $login,
        // Generated, never returned and never recorded: a minted token is the only way in.
        'user_pass' => wp_generate_password(64, true, true),
        'user_email' => wpj_actor_email($role),
        'display_name' => 'wp-journeys ' . $role,
        'role' => $role,
    ));
    if (is_wp_error($id)) {
        return $id;
    }
    return array('userId' => (int) $id);
}

/**
 * Mint a single-use, five-minute URL that logs a browser in as one of the runner's actors.
 *
 * @param int $user_id a user id from wpj_ensure_actor()
 * @return array{url:string}|WP_Error
 */
function wpj_mint_login($user_id) {
    $user_id = (int) $user_id;
    $user = $user_id > 0 ? get_userdata($user_id) : false;
    if (!$user) {
        return new WP_Error('wpj_bad_user', 'no such user', array('status' => 400));
    }
    if (wpj_actor_role_for($user->user_login, $user->user_email) === '') {
        // This endpoint hands out live auth material. It does so only for users the runner
        // created, so even a leaked secret cannot become a session as a real person.
        return new WP_Error(
            'wpj_not_an_actor',
            'refusing to mint a login for a user the runner did not create',
            array('status' => 403)
        );
    }

    $token = wp_generate_password(32, false);
    // Five minutes: long enough for the browser to follow the URL, short enough that an
    // unspent token is worthless by the time anyone finds it.
    set_transient(wpj_login_token_key($token), $user_id, 300);
    return array('url' => add_query_arg('wpj_login', $token, home_url('/')));
}

/**
 * Spend a minted token: authenticate the browser as that actor and redirect to wp-admin.
 *
 * Exits on success. Any doubt at all — a malformed, unknown, expired or already-spent token,
 * or a user that is no longer one of ours — returns silently and the request renders as
 * usual. The caller has already run the guard; the token is the only credential here,
 * because a browser navigation cannot carry the secret header.
 *
 * @param string $token the wpj_login query value
 */
function wpj_consume_login($token) {
    if (!wpj_login_token_valid($token)) {
        return;
    }
    $key = wpj_login_token_key($token);
    $user_id = (int) get_transient($key);
    // Single use: only the request whose delete actually removed the row goes on, so two
    // fetches of one URL can never both authenticate.
    if (!delete_transient($key) || $user_id <= 0) {
        return;
    }
    $user = get_userdata($user_id);
    if (!$user || wpj_actor_role_for($user->user_login, $user->user_email) === '') {
        return;
    }

    wp_set_auth_cookie($user_id, true);
    // Nothing between here and the browser may cache a response carrying a session cookie.
    nocache_headers();
    wp_safe_redirect(admin_url());
    exit;
}
