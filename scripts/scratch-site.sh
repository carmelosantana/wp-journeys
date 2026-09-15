#!/usr/bin/env bash
# Create the throwaway wp-harness site the integration tests run against.
# Never touches alpacabot, alpaca10 or alpacapc.
#
# The shared secret lives in ./.env (git-ignored). Re-running reuses it; it is generated only
# when neither the environment nor ./.env supplies one. Later tasks load it with
#   set -a; . ./.env; set +a
set -euo pipefail
WPH="node $WPH_CHECKOUT/bin/wph.js"
SITE=wpjtest
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
if [ -z "${WPJ_AGENT_SECRET:-}" ]; then
  WPJ_AGENT_SECRET="$(openssl rand -hex 16)"
  echo "generated a new shared secret"
fi
if [ "${#WPJ_AGENT_SECRET}" -lt 16 ]; then
  echo "WPJ_AGENT_SECRET must be at least 16 characters (the agent refuses a shorter one)" >&2
  exit 1
fi
# Persist whichever secret is in use, so wp-config.php and ./.env never disagree.
if ! grep -qs '^WPJ_AGENT_SECRET=' "$ENV_FILE"; then
  (
    umask 077
    {
      grep -qs '^WPJ_BASE_URL=' "$ENV_FILE" || echo "WPJ_BASE_URL=https://$SITE.wp.test"
      echo "WPJ_AGENT_SECRET=$WPJ_AGENT_SECRET"
    } >> "$ENV_FILE"
  )
  echo "wrote the shared secret to $ENV_FILE"
fi
SECRET=$WPJ_AGENT_SECRET

$WPH site create "$SITE" || $WPH site start "$SITE"
AGENT_DIR="$ROOT/mu-plugin"
$WPH mount "$SITE" mu wp-journeys-agent "$AGENT_DIR"
$WPH mount "$SITE" mu wp-journeys-agent.php "$AGENT_DIR/loader.php"
$WPH wp "$SITE" -- config set WP_DEBUG true --raw
$WPH wp "$SITE" -- config set WP_DEBUG_LOG true --raw
$WPH wp "$SITE" -- config set WP_ENVIRONMENT_TYPE local
$WPH wp "$SITE" -- config set WPJ_AGENT true --raw
# wp-cli echoes the value it writes; keep the secret out of the terminal and any CI log.
$WPH wp "$SITE" -- config set WPJ_AGENT_SECRET "$SECRET" > /dev/null
echo "WPJ_AGENT_SECRET set (value in $ENV_FILE)"
# Pretty permalinks, as most real sites run. The runner does not need them (it addresses the agent
# by ?rest_route=, which works on plain permalinks too); this only lets hand-run curl checks use /wp-json/.
$WPH wp "$SITE" -- rewrite structure '/%postname%/'
echo "https://$SITE.wp.test ready"
