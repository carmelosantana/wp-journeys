#!/usr/bin/env bash
#
# Live proof of the agent's actor provisioning and login minting, against a running dev site.
#
# The WordPress-touching half of mu-plugin/src/actors.php cannot be reached by the unit tests:
# it needs a real database, real cookies and a real wp-admin. This script is that half's net,
# and it is what R20 (which user does the minted cookie authenticate as?) and R36 (a forged
# user is never adopted) are proven with. Re-run it after any change to actors.php.
#
#   ./scripts/prove-login-minting.sh
#   WPJ_WP_CLI="node /path/to/wph.js wp wpjtest" ./scripts/prove-login-minting.sh   # + R36
#
# It reads WPJ_BASE_URL and WPJ_AGENT_SECRET from .env, prints PASS/FAIL/SKIP per assertion,
# and exits non-zero if anything failed. It never prints the secret, a token or a cookie:
# minted URLs are redacted, and jars are counted, never shown.
#
# The forged-user checks need wp-cli against the target site, which this script has no
# portable way to find. Without WPJ_WP_CLI they SKIP loudly rather than quietly passing.

set -u -o pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${WPJ_ENV_FILE:-$ROOT/.env}"

if [ ! -r "$ENV_FILE" ]; then
  echo "no readable $ENV_FILE — the agent secret lives there (see the README)" >&2
  exit 2
fi
set -a; . "$ENV_FILE"; set +a
: "${WPJ_BASE_URL:?WPJ_BASE_URL is not set}"
: "${WPJ_AGENT_SECRET:?WPJ_AGENT_SECRET is not set}"

# The same local-only gate as src/config.ts and the agent's own guard: this script creates
# users and mints logins, so it must never be pointed at a real site.
case "$WPJ_BASE_URL" in
  *://localhost*|*://127.0.0.1*|*://\[::1\]*|*.test|*.test/|*.test:*|*.localhost*) ;;
  *) echo "refusing a non-local target: $WPJ_BASE_URL" >&2; exit 2 ;;
esac

PASS=0; FAIL=0; SKIPPED=0
JARS="$(mktemp -d)"
trap 'rm -rf "$JARS"' EXIT   # no cookie jar outlives the run

redact() { sed -E 's/wpj_login=[A-Za-z0-9]+/wpj_login=<REDACTED>/g'; }
ok()   { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n' "$1" "$2" "$3"; }
skip() { SKIPPED=$((SKIPPED + 1)); printf 'SKIP  %s\n        %s\n' "$1" "$2"; }
is()   { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2" "$(printf '%s' "$3" | redact)"; fi; }
has()  { case "$3" in *"$2"*) ok "$1" ;; *) bad "$1" "a reply containing $2" "$(printf '%s' "$3" | redact)" ;; esac; }

api() {
  curl -sS -X POST "$WPJ_BASE_URL/?rest_route=/wp-journeys/v1/agent" \
    -H 'Content-Type: application/json' -H "X-WPJ-Secret: $WPJ_AGENT_SECRET" -d "$1"
}
ensure() { api "{\"action\":\"ensureActor\",\"args\":{\"role\":\"$1\"}}"; }
mint()   { api "{\"action\":\"mintLogin\",\"args\":{\"userId\":$1}}"; }
user_id() { sed -E 's/.*"userId":([0-9]+).*/\1/'; }
# WordPress escapes the slashes in JSON; nothing else in the URL carries a backslash.
minted_url() { sed -E 's/.*"url":"([^"]+)".*/\1/' | tr -d '\\'; }

WP="${WPJ_WP_CLI:-}"
wp_cli() { $WP "$@" 2>/dev/null; }

echo "== target: $WPJ_BASE_URL"
echo

echo "-- 0. the log baseline, so we can prove none of this writes a diagnostic"
BASELINE="$(api '{"action":"logDelta","args":{"offset":"end"}}')"
OFFSET="$(printf '%s' "$BASELINE" | sed -E 's/.*"offset":([0-9]+).*/\1/')"
has "the agent answers a log baseline" '"available":true' "$BASELINE"
echo

# --- R20: provisioning, identity, and single use -------------------------------------------

prove_actor() {
  role="$1"
  reply="$(ensure "$role")"
  id="$(printf '%s' "$reply" | user_id)"
  case "$id" in
    ''|*[!0-9]*) bad "ensureActor $role returns a user id" "a number" "$reply"; return ;;
  esac
  ok "ensureActor $role returns user id $id"
  is "ensureActor $role is idempotent" "$id" "$(ensure "$role" | user_id)"

  url="$(mint "$id" | minted_url)"
  case "$url" in
    *wpj_login=*) ok "mintLogin $role returns a token URL" ;;
    *) bad "mintLogin $role returns a token URL" "a ?wpj_login= URL" "$url"; return ;;
  esac

  jar="$JARS/$role"
  is "the minted URL for $role redirects into wp-admin" \
    "302" "$(curl -sS -o /dev/null -w '%{http_code}' -c "$jar" "$url")"

  # R20: the point of the whole exercise — WHICH user is this session?
  seen="$(curl -sS -b "$jar" "$WPJ_BASE_URL/wp-admin/profile.php" \
    | grep -o 'name="user_login"[^>]*value="[^"]*"' | sed -E 's/.*value="([^"]*)".*/\1/' | head -1)"
  is "the session reads as wpj_$role on /wp-admin/profile.php" "wpj_$role" "$seen"

  # The same URL a second time, with a jar that has never been authenticated.
  replay="$JARS/$role-replay"
  curl -sS -o /dev/null -c "$replay" "$url"
  is "a replayed token for $role sets no session cookie" \
    "0" "$(grep -c 'wordpress_logged_in' "$replay" || true)"
  loc="$(curl -sS -o /dev/null -w '%{redirect_url}' -b "$replay" "$WPJ_BASE_URL/wp-admin/profile.php")"
  case "$loc" in
    *wp-login.php*) ok "a replayed token for $role authenticates nobody" ;;
    *) bad "a replayed token for $role authenticates nobody" "a redirect to wp-login.php" "$loc" ;;
  esac
}

echo "-- 1. R20: the minted cookie is that actor, and the token is spent by one use"
prove_actor editor
prove_actor subscriber
echo

echo "-- 2. every actor provisions, and carries the ownership mark"
for role in subscriber contributor author editor administrator; do
  has "ensureActor $role" '"userId"' "$(ensure "$role")"
done
echo

# --- R36: the ownership mark is what decides, not the login and mail ------------------------

echo "-- 3. R36: a forged user with the right login and mail but no mark is refused"
if [ -z "$WP" ]; then
  skip "a forged user is refused by ensureActor and mintLogin" \
    "set WPJ_WP_CLI to a wp-cli invocation for this site, e.g. WPJ_WP_CLI=\"wp --path=/var/www/html\""
else
  wp_cli user delete wpj_contributor --yes >/dev/null
  # Exactly what a visitor could register for themselves on a site with open registration.
  wp_cli user create wpj_contributor wpj_contributor@wp-journeys.invalid \
    --role=subscriber --porcelain >/dev/null
  forged_id="$(wp_cli user get wpj_contributor --field=ID)"

  case "$forged_id" in
    ''|*[!0-9]*) skip "a forged user is refused" "could not create one through WPJ_WP_CLI" ;;
    *)
      has "ensureActor refuses a user it did not create" \
        '"wpj_actor_conflict"' "$(ensure contributor)"
      has "mintLogin refuses a user it did not create" \
        '"wpj_not_an_actor"' "$(mint "$forged_id")"
      is "the forged user is left exactly as it was, not promoted" \
        "subscriber" "$(wp_cli user get wpj_contributor --field=roles)"

      wp_cli user delete wpj_contributor --yes >/dev/null
      has "ensureActor provisions the real actor once the forgery is gone" \
        '"userId"' "$(ensure contributor)"
      is "the user the runner created carries the mark" \
        "contributor" "$(wp_cli user meta get wpj_contributor wpj_actor)"
      ;;
  esac
fi
echo

echo "-- 4. every refusal fails closed"
has "mintLogin refuses the site's own administrator (user 1)" '"wpj_not_an_actor"' "$(mint 1)"
has "mintLogin refuses a user that does not exist" '"wpj_bad_user"' "$(mint 999999)"
has "ensureActor says anonymous needs no user" '"wpj_anonymous_actor"' "$(ensure anonymous)"
has "ensureActor refuses an unknown role" '"wpj_bad_role"' "$(ensure superadmin)"
has "the REST door refuses a request with no secret" '"wpj_refused"' \
  "$(curl -sS -X POST "$WPJ_BASE_URL/?rest_route=/wp-journeys/v1/agent" \
      -H 'Content-Type: application/json' -d '{"action":"mintLogin","args":{"userId":1}}')"
made_up="$(printf 'z%.0s' $(seq 32))"
fabricated="$JARS/fabricated"
curl -sS -o /dev/null -c "$fabricated" "$WPJ_BASE_URL/?wpj_login=$made_up"
is "a fabricated token sets no session cookie" \
  "0" "$(grep -c 'wordpress_logged_in' "$fabricated" || true)"
echo

echo "-- 5. an actor whose role drifted is put back"
if [ -z "$WP" ]; then
  skip "a drifted role is restored by ensureActor" "set WPJ_WP_CLI to a wp-cli invocation for this site"
else
  wp_cli user set-role wpj_editor subscriber >/dev/null
  is "precondition: the actor's role was changed out from under the runner" \
    "subscriber" "$(wp_cli user get wpj_editor --field=roles)"
  ensure editor >/dev/null
  is "ensureActor restores the role a journey claims to run as" \
    "editor" "$(wp_cli user get wpj_editor --field=roles)"
fi
echo

echo "-- 6. none of the above wrote a line to debug.log"
DELTA="$(api "{\"action\":\"logDelta\",\"args\":{\"offset\":$OFFSET}}")"
has "the debug.log delta is empty" '"lines":[]' "$DELTA"
echo

printf '%s passed, %s failed, %s skipped\n' "$PASS" "$FAIL" "$SKIPPED"
[ "$FAIL" -eq 0 ]
