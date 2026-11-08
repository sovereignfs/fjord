#!/usr/bin/env bash
# Bring the image up in each of the three documented setups (deploy/) from nothing, as an operator would, and check
# that each one is up and keeps what it is given (ROADMAP 1a.12), and that a Sovereign instance can host it (ROADMAP H2):
#
#   eval "docker build -f clients/web/Dockerfile $(pnpm --dir clients/web exec sovereign-manifest docker-args) -t fjord-web:ci ."   # from the root
#   FJORD_IMAGE=fjord-web:ci clients/web/scripts/deploy-check.sh   # all four, or name some: sqld file postgres sovereign
#
# For each setup it starts the compose files, waits for them to report healthy, asks /api/health which database it is
# on and whether the format module loaded, makes the first account, takes the whole thing down *without* its volumes
# and up again, and signs in: so the data is still there, on that database. A missing sign-in secret must stop the
# image with a message that names it. It never touches deploy/.env if there is one: it stops instead.
#
# `sovereign` is not a compose setup. It checks what a Sovereign instance relies on (sovereign.manifest.json, the contract is
# `contracts/app-manifest.md` in sovereignfs/sovereign): the image's label is the manifest and its exposed port is the manifest's; and the
# image, given what `sv apply` gives an app (PORT, its address, its secrets as files named by `_FILE`, a PostgreSQL database, core's
# address and its client) comes up on that PORT and no other, serves its icon to someone with no session, offers sign-in through
# Sovereign, answers the two addresses the manifest names for Sovereign's notices (no token is 400, a GET is 405, a notice it cannot
# check is 503), and stops on SIGTERM within seconds. Next finishes what is in flight and exits 143, the signal's own code; a container that
# had to be killed after the grace period would say 137. It needs no Sovereign: the address of core is never asked at start-up.
#
# Written for bash 3.2.
# $files is a list of `-f` arguments and is split on purpose.
# shellcheck disable=SC2086
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/deploy"

image="${FJORD_IMAGE:-fjord-web}"
port="${FJORD_CHECK_PORT:-3987}"
setups="${*:-sqld file postgres sovereign}"

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
  docker rm -f fjord-check-sv fjord-check-sv-db >/dev/null 2>&1 || true
  docker network rm fjord-check-sv >/dev/null 2>&1 || true
  if [ -n "${sv_dir:-}" ]; then rm -rf "$sv_dir"; fi
}
trap cleanup EXIT

export FJORD_IMAGE="$image" FJORD_PORT="$port"
fail() { echo "FAIL: $*" >&2; docker compose -p "$project" $files logs --no-color --tail 40 >&2 || true; exit 1; }

up() { docker compose -p "$project" $files up -d --no-build --wait --wait-timeout 240 >/dev/null 2>&1 || fail "$1: did not become healthy"; }

# The first account, then its sign-in: the same request an operator's browser makes, with this site's origin.
post() { curl -sS -o /dev/null -w '%{http_code}' -X POST "http://localhost:$port$1" -H "origin: http://localhost:$port" -H 'content-type: application/json' --data "$2"; }


# The same image, given what a Sovereign instance gives an app (contracts/app-manifest.md §3) and what its operator sets.
check_sovereign() {
  echo "== sovereign"
  manifest="$root/sovereign.manifest.json"
  sv_net="fjord-check-sv"
  sv_fail() { echo "FAIL: sovereign: $*" >&2; docker logs --tail 40 fjord-check-sv >&2 2>&1 || true; exit 1; }

  # The label is how the instance reads the manifest without pulling the image, and the port is written once.
  label="$(docker image inspect -f '{{ index .Config.Labels "io.github.sovereignfs.app-manifest" }}' "$image")"
  [ -n "$label" ] || sv_fail "the image has no io.github.sovereignfs.app-manifest label (build it with sovereign-manifest docker-args)"
  node -e 'const { isDeepStrictEqual } = require("node:util"); const a = JSON.parse(process.argv[1]); const b = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8")); process.exit(isDeepStrictEqual(a, b) ? 0 : 1)' "$label" "$manifest" \
    || sv_fail "the image's label is not sovereign.manifest.json"
  manifest_port="$(node -p 'require(process.argv[1]).port' "$manifest")"
  case "$(docker image inspect -f '{{ json .Config.ExposedPorts }}' "$image")" in
    "{\"$manifest_port/tcp\":{}}") ;;
    *) sv_fail "the image exposes $(docker image inspect -f '{{ json .Config.ExposedPorts }}' "$image"), not $manifest_port/tcp" ;;
  esac

  # What `sv apply` writes: each secret a file, each setting a variable. A PORT that is not the default shows that PORT is what is read.
  sv_dir="$(mktemp -d)"
  chmod 755 "$sv_dir"
  printf '%s' "$secret" >"$sv_dir/FJORD_AUTH_SECRET"
  printf '%s' "$key" >"$sv_dir/FJORD_ENCRYPTION_KEY"
  printf '%s' "$(openssl rand -hex 16)" >"$sv_dir/FJORD_CORE_CLIENT_SECRET"
  printf 'postgres://fjord:%s@fjord-check-sv-db:5432/fjord' "$password" >"$sv_dir/FJORD_POSTGRES_URL"
  chmod 644 "$sv_dir"/*
  sv_port=$((manifest_port + 111))

  docker network create "$sv_net" >/dev/null
  # The database the compose overlay uses (compose.postgres.yaml).
  docker run -d --name fjord-check-sv-db --network "$sv_net" -e POSTGRES_USER=fjord -e POSTGRES_DB=fjord -e "POSTGRES_PASSWORD=$password" postgres:16-alpine >/dev/null
  waited=0
  until docker exec fjord-check-sv-db pg_isready -U fjord -d fjord >/dev/null 2>&1; do
    waited=$((waited + 1))
    [ "$waited" -le 60 ] || sv_fail "PostgreSQL did not become ready"
    sleep 1
  done

  docker run -d --name fjord-check-sv --network "$sv_net" -p "127.0.0.1:$port:$sv_port" -v "$sv_dir:/run/secrets:ro" \
    -e "PORT=$sv_port" -e "FJORD_URL=http://localhost:$port" \
    -e FJORD_CORE_URL=https://core.sovereign.test -e FJORD_CORE_CLIENT_ID=client-fjord -e FJORD_CORE_CLIENT_SECRET_FILE=/run/secrets/FJORD_CORE_CLIENT_SECRET \
    -e FJORD_AUTH_SECRET_FILE=/run/secrets/FJORD_AUTH_SECRET \
    -e FJORD_DB_DIALECT=postgres -e FJORD_POSTGRES_URL_FILE=/run/secrets/FJORD_POSTGRES_URL -e FJORD_POSTGRES_DIRECT_URL_FILE=/run/secrets/FJORD_POSTGRES_URL -e FJORD_POSTGRES_POOL_MAX=10 \
    -e FJORD_AUTH_SIGNUP=open -e FJORD_ENCRYPTION_KEY_FILE=/run/secrets/FJORD_ENCRYPTION_KEY \
    "$image" >/dev/null

  waited=0
  until health="$(curl -fsS "http://localhost:$port/api/health" 2>/dev/null)"; do
    waited=$((waited + 1))
    [ "$waited" -le 120 ] || sv_fail "it did not answer /api/health on PORT=$sv_port"
    [ "$(docker inspect -f '{{.State.Running}}' fjord-check-sv)" = true ] || sv_fail "it stopped"
    sleep 1
  done
  case "$health" in *'"dialect":"postgres"'*) ;; *) sv_fail "expected postgres, got $health" ;; esac
  case "$health" in *'"format":"ok"'*) ;; *) sv_fail "the format module did not load: $health" ;; esac

  # Only Sovereign signs people in here: the page offers it, and not email and password.
  page="$(curl -sS "http://localhost:$port/sign-in")"
  case "$page" in *[Ss]overeign*) ;; *) sv_fail "/sign-in does not offer Sovereign" ;; esac
  case "$page" in *'type="password"'*) sv_fail "/sign-in offers a password, though only Sovereign is set up" ;; esac
  # The launcher shows the icon to someone who has no session here.
  icon="$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' "http://localhost:$port/icon.svg")"
  case "$icon" in "200 image/svg+xml"*) ;; *) sv_fail "/icon.svg answered '$icon'" ;; esac

  # The two addresses the manifest names for Sovereign's notices are there: no token is refused, only a POST is taken, and a notice that cannot
  # be checked because the instance cannot be reached (this one is not) is "try again", never "done".
  notice() { curl -sS -o /dev/null -w '%{http_code}' "$@" "http://localhost:$port/api/sovereign/$path"; }
  for path in backchannel-logout account-deleted; do
    [ "$(notice -X POST -H 'content-type: application/x-www-form-urlencoded' --data '')" = 400 ] || sv_fail "/api/sovereign/$path did not refuse a notice with no token"
    [ "$(notice)" = 405 ] || sv_fail "/api/sovereign/$path took something other than a POST"
  done
  [ "$(path=backchannel-logout notice -X POST --data-urlencode 'logout_token=a.b.c')" = 503 ] || sv_fail "a logout notice that could not be checked was not answered 503"
  [ "$(path=account-deleted notice -X POST --data-urlencode 'account_deleted_token=a.b.c')" = 503 ] || sv_fail "a deletion that could not be checked was not answered 503"

  # `sv` stops an app with SIGTERM and gives it 30 seconds: it must end within seconds by handling the signal, not wait to be killed.
  # Next's server finishes what is in flight and exits with the signal's own code, 143; a kill after the grace period is 137.
  started="$(date +%s)"
  docker stop -t 20 fjord-check-sv >/dev/null
  elapsed=$(($(date +%s) - started))
  code="$(docker inspect -f '{{.State.ExitCode}}' fjord-check-sv)"
  case "$code" in 0 | 143) ;; *) sv_fail "SIGTERM ended it with exit code $code (137 is a kill after the grace period)" ;; esac
  [ "$elapsed" -lt 15 ] || sv_fail "SIGTERM took $elapsed seconds"

  docker rm -f fjord-check-sv fjord-check-sv-db >/dev/null 2>&1 || true
  docker network rm "$sv_net" >/dev/null 2>&1 || true
  rm -rf "$sv_dir"
  sv_dir=""
  echo "   the label is the manifest, PORT=$sv_port honoured, Sovereign sign-in offered, the icon served, the notice addresses answering, stopped by SIGTERM in ${elapsed}s (exit code $code)"
}

for setup in $setups; do
  if [ "$setup" = sovereign ]; then check_sovereign; continue; fi
  case "$setup" in
    sqld) files="-f compose.yaml"; dialect="sqlite" ;;
    file) files="-f compose.file.yaml"; dialect="sqlite" ;;
    postgres) files="-f compose.yaml -f compose.postgres.yaml"; dialect="postgres" ;;
    *) echo "unknown setup: $setup (sqld, file, postgres or sovereign)" >&2; exit 2 ;;
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
id="$(docker run -d -e FJORD_AUTH_LOCAL=1 -e FJORD_URL=http://localhost:3001 -e FJORD_DB_DIALECT=sqlite -e FJORD_SQLITE_URL=file:/tmp/x.db "$image")"
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
