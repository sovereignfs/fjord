#!/usr/bin/env bash
# Bring the image up in each of the three documented setups (deploy/) from nothing, as an operator would, and check
# that each one is up and keeps what it is given (ROADMAP 1a.12):
#
#   docker build -f clients/web/Dockerfile -t fjord-web:ci .       # from the root of the repository
#   FJORD_IMAGE=fjord-web:ci clients/web/scripts/deploy-check.sh   # all three, or name some: sqld file postgres
#
# For each setup it starts the compose files, waits for them to report healthy, asks /api/health which database it is
# on and whether the format module loaded, makes the first account, takes the whole thing down *without* its volumes
# and up again, and signs in: so the data is still there, on that database. A missing sign-in secret must stop the
# image with a message that names it. It never touches deploy/.env if there is one: it stops instead.
#
# Written for bash 3.2.
# $files is a list of `-f` arguments and is split on purpose.
# shellcheck disable=SC2086
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/deploy"

image="${FJORD_IMAGE:-fjord-web}"
port="${FJORD_CHECK_PORT:-3987}"
setups="${*:-sqld file postgres}"

if [ -e .env ]; then
  echo "deploy/.env exists; this check writes its own and will not overwrite yours. Move it aside and run again." >&2
  exit 2
fi

secret="$(openssl rand -base64 48)"
key="$(openssl rand -base64 32)"
password="$(openssl rand -hex 16)"
account="check-$(openssl rand -hex 4)@example.com"
account_password="$(openssl rand -hex 12)"

cat >.env <<ENV
FJORD_URL=http://localhost:$port
FJORD_AUTH_LOCAL=1
FJORD_AUTH_SECRET=$secret
FJORD_ENCRYPTION_KEY=$key
POSTGRES_PASSWORD=$password
ENV

project=""
files=""
cleanup() {
  if [ -n "$project" ]; then docker compose -p "$project" $files down -v --remove-orphans >/dev/null 2>&1 || true; fi
  rm -f .env
}
trap cleanup EXIT

export FJORD_IMAGE="$image" FJORD_PORT="$port"
fail() { echo "FAIL: $*" >&2; docker compose -p "$project" $files logs --no-color --tail 40 >&2 || true; exit 1; }

up() { docker compose -p "$project" $files up -d --no-build --wait --wait-timeout 240 >/dev/null 2>&1 || fail "$1: did not become healthy"; }

# The first account, then its sign-in: the same request an operator's browser makes, with this site's origin.
post() { curl -sS -o /dev/null -w '%{http_code}' -X POST "http://localhost:$port$1" -H "origin: http://localhost:$port" -H 'content-type: application/json' --data "$2"; }

for setup in $setups; do
  case "$setup" in
    sqld) files="-f compose.yaml"; dialect="sqlite" ;;
    file) files="-f compose.file.yaml"; dialect="sqlite" ;;
    postgres) files="-f compose.yaml -f compose.postgres.yaml"; dialect="postgres" ;;
    *) echo "unknown setup: $setup (sqld, file or postgres)" >&2; exit 2 ;;
  esac
  project="fjord-check-$setup"
  echo "== $setup"

  up "$setup"
  health="$(curl -fsS "http://localhost:$port/api/health")" || fail "$setup: /api/health did not answer"
  case "$health" in *"\"dialect\":\"$dialect\""*) ;; *) fail "$setup: expected $dialect, got $health" ;; esac
  case "$health" in *'"format":"ok"'*) ;; *) fail "$setup: the format module did not load: $health" ;; esac
  [ "$(curl -sS -o /dev/null -w '%{http_code}' "http://localhost:$port/sign-in")" = 200 ] || fail "$setup: /sign-in is not served"
  # The image's own server sends the Content-Security-Policy, with a nonce on the page's scripts (DESIGN.md §15).
  headers="$(curl -sS -D - -o /tmp/fjord-signin.html "http://localhost:$port/sign-in")"
  case "$headers" in *[Cc]ontent-[Ss]ecurity-[Pp]olicy:*"script-src 'self' 'nonce-"*) ;; *) fail "$setup: /sign-in is sent without a Content-Security-Policy with a nonce" ;; esac
  grep -q '<script[^>]* nonce=' /tmp/fjord-signin.html || fail "$setup: the scripts of /sign-in carry no nonce"

  status="$(post /api/auth/sign-up/email "{\"name\":\"Check\",\"email\":\"$account\",\"password\":\"$account_password\"}")"
  [ "$status" = 200 ] || fail "$setup: the first account was not made (HTTP $status)"

  # Down and up again, keeping the volumes: what was made must still be there.
  docker compose -p "$project" $files down >/dev/null 2>&1 || fail "$setup: could not be taken down"
  up "$setup"
  status="$(post /api/auth/sign-in/email "{\"email\":\"$account\",\"password\":\"$account_password\"}")"
  [ "$status" = 200 ] || fail "$setup: the account did not survive a restart (HTTP $status)"

  docker compose -p "$project" $files down -v --remove-orphans >/dev/null 2>&1 || true
  project=""
  echo "   up on $dialect, format module loaded, an account kept across a restart"
done

# Refuses to start on a setting that is wrong, and says which: the container must stop, not stay up and fail.
echo "== a missing secret"
id="$(docker run -d -e FJORD_AUTH_LOCAL=1 -e FJORD_URL=http://localhost:3000 -e SQLITE_URL=file:/tmp/x.db "$image")"
trap 'docker rm -f "$id" >/dev/null 2>&1 || true; cleanup' EXIT
waited=0
while [ "$(docker inspect -f '{{.State.Running}}' "$id")" = true ]; do
  waited=$((waited + 1))
  if [ "$waited" -gt 30 ]; then echo "FAIL: the image is still running 30 seconds after being given sign-in with no FJORD_AUTH_SECRET" >&2; exit 1; fi
  sleep 1
done
[ "$(docker inspect -f '{{.State.ExitCode}}' "$id")" != 0 ] || { echo "FAIL: it stopped, but with exit code 0" >&2; exit 1; }
case "$(docker logs "$id" 2>&1)" in *FJORD_AUTH_SECRET*) echo "   stopped, and named FJORD_AUTH_SECRET" ;; *) echo "FAIL: it stopped, but did not name FJORD_AUTH_SECRET:" >&2; docker logs "$id" >&2; exit 1 ;; esac
echo "ok"
