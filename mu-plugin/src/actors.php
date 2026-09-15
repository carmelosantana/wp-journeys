<?php
/**
 * The runner's own WordPress users, and the one-time URL that logs a browser in as one.
 *
 * Two rules shape this file:
 *
 * 1. The runner touches ONLY users it created, and it knows which those are from a mark it
 *    writes itself: the `wpj_actor` user meta, set once at creation. The login and the
 *    reserved-.invalid mail address are a cheap pre-filter and nothing more — both are
 *    deterministic and published right here, so on a site with open registration a visitor
 *    could register `wpj_administrator` with that very address. Without the mark such a user
 *    is a CONFLICT: never adopted, never promoted, never logged into.
 * 2. A minted token is live auth material. It comes from random_bytes(), is stored only as a
 *    SHA-256 hash, is spent by the one request that actually deletes its row, and is never
 *    written to a log.
 *
 * One caveat on that "one request": it holds on the database transient path, where
 * delete_transient() deletes a row and reports whether it removed one. With a persistent
 * object cache in place it delegates to wp_cache_delete(), and how two simultaneous deletes
 * race is then the caching backend's business, not ours.
 *
 * The naming, ownership and token rules are pure, so they are tested without WordPress; the
 * functions that read and write the database are thin wrappers over them.
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

/** The user meta key the runner stamps its own users with, holding the actor's role. */
function wpj_actor_meta_key() {
    return 'wpj_actor';
}

/**
 * The role the runner OWNS this user as, or '' for every other user on the site.
 *
 * The mark is the authority. The login and mail pre-filter is kept because it is free and
 * catches the ordinary case first, but on its own it proves nothing: anyone who can register
 * can choose both halves. Only the runner can write the meta.
 *
 * @param string $login a user's user_login
 * @param string $email that user's user_email
 * @param mixed  $mark  that user's wpj_actor meta ('' or false when absent)
 * @return string the actor role, or '' for any user the runner does not own
 */
function wpj_actor_owned_role($login, $email, $mark) {
    $role = wpj_actor_role_for($login, $email);
    if ($role === '' || !is_string($mark) || $mark !== $role) {
        return '';
    }
    return $role;
}

/**
 * Why this role gets no user, or '' when it gets one.
 *
 * `anonymous` is not an error the caller should go hunting for: it is a real actor that simply
 * has no login, and saying so is the difference between a puzzling failure and an obvious one.
 *
 * @param mixed $role
 * @return string
 */
function wpj_actor_provision_refusal($role) {
    if (wpj_actor_login($role) !== '') {
        return '';
    }
    if ($role === 'anonymous') {
        return 'anonymous has no user: it is the one actor the runner never provisions';
    }
    // A non-string role names its type rather than being cast: "Array to string conversion"
    // would put a warning in debug.log, which the runner reads as the plugin's own signal.
    return sprintf(
        'unknown actor role %s',
        is_string($role) ? '"' . $role . '"' : '(' . gettype($role) . ')'
    );
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
    $refusal = wpj_actor_provision_refusal($role);
    if ($refusal !== '') {
        return new WP_Error(
            $role === 'anonymous' ? 'wpj_anonymous_actor' : 'wpj_bad_role',
            $refusal,
            array('status' => 400)
        );
    }
    $login = wpj_actor_login($role);

    $user = get_user_by('login', $login);
    if ($user) {
        // The mark decides. A user who merely looks like an actor is somebody else's account:
        // adopting it here would hand its owner whatever role the runner went on to set.
        if (wpj_actor_owned_role_of_user($user) !== $role) {
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
        // random_bytes(), not wp_generate_password(): that one returns through the
        // `random_password` filter, so the plugin under test could read or pin it.
        // Never returned and never recorded — a minted token is the only way in.
        'user_pass' => bin2hex(random_bytes(32)),
        'user_email' => wpj_actor_email($role),
        'display_name' => 'wp-journeys ' . $role,
        'role' => $role,
    ));
    if (is_wp_error($id)) {
        return $id;
    }
    // The mark, written here and nowhere else, is what every later ownership decision reads.
    // $unique = true, so it can never become a second, conflicting value.
    add_user_meta((int) $id, wpj_actor_meta_key(), $role, true);
    return array('userId' => (int) $id);
}

/**
 * The role the runner owns this user as, reading the mark it wrote at creation.
 *
 * @param WP_User|false $user
 * @return string the actor role, or '' for any user the runner does not own
 */
function wpj_actor_owned_role_of_user($user) {
    if (!$user || !isset($user->ID)) {
        return '';
    }
    return wpj_actor_owned_role(
        $user->user_login,
        $user->user_email,
        get_user_meta((int) $user->ID, wpj_actor_meta_key(), true)
    );
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
    if (wpj_actor_owned_role_of_user($user) === '') {
        // This endpoint hands out live auth material. It does so only for users carrying the
        // runner's own mark, so neither a leaked secret nor a registered look-alike can become
        // a session as a real person.
        return new WP_Error(
            'wpj_not_an_actor',
            'refusing to mint a login for a user the runner did not create',
            array('status' => 403)
        );
    }

    // 16 random bytes as 32 hex characters. Not wp_generate_password(), whose result passes
    // through the `random_password` filter — the plugin under test could watch every token.
    $token = bin2hex(random_bytes(16));
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
    if (!$user || wpj_actor_owned_role_of_user($user) === '') {
        return;
    }

    // $remember = false. A five-minute token has no business minting a fourteen-day session:
    // the cookie outlives the journey, and Playwright's retain-on-failure trace would carry it
    // into an artefact. Core's non-remembered expiry is ample for a journey.
    wp_set_auth_cookie($user_id, false);
    // Nothing between here and the browser may cache a response carrying a session cookie.
    nocache_headers();
    wp_safe_redirect(admin_url());
    exit;
}
