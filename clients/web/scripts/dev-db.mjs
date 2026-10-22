// Start a local database for development, in Docker, and say which variables to use.
//
//   pnpm db:dev sqld        # sqld, the default for Fjord Web (DESIGN.md §14)
//   pnpm db:dev postgres    # PostgreSQL, for trying the other dialect
//   pnpm db:dev stop        # stop whichever is running (the data stays)
//
// Neither is needed to develop: a `file:` URL works with no Docker at all,
//
//   SQLITE_URL=file:./data/fjord.db pnpm dev
//
// The containers are named, persistent and bound to localhost on unusual ports, so they
// neither collide with a database you already run nor lose data between sessions.
// The images are the ones CI runs; a test keeps the two in step.
import { spawnSync } from "node:child_process";

const SQLD_IMAGE = "ghcr.io/tursodatabase/libsql-server:v0.24.33"; // not 0.24.32: it ignores x-namespace
const POSTGRES_IMAGE = "postgres:16-alpine";

const SQLD = { name: "fjord-dev-sqld", volume: "fjord-dev-sqld-data", port: 28080, adminPort: 28081 };
const POSTGRES = { name: "fjord-dev-postgres", volume: "fjord-dev-postgres-data", port: 25432 };

const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" });

function fail(message) {
  console.error(message);
  process.exit(1);
}

function requireDocker() {
  const result = docker("info");
  if (result.error || result.status !== 0) fail("Docker is not running. Start it, or develop against a file: SQLITE_URL=file:./data/fjord.db");
}

/** running / stopped / missing */
function stateOf(name) {
  const result = docker("inspect", "--format", "{{.State.Status}}", name);
  if (result.status !== 0) return "missing";
  return result.stdout.trim() === "running" ? "running" : "stopped";
}

function ensureContainer(name, createArgs) {
  const state = stateOf(name);
  if (state === "running") return;
  const result = state === "stopped" ? docker("start", name) : docker("run", "-d", "--name", name, ...createArgs);
  if (result.status !== 0) fail(`could not start ${name}:\n${result.stderr}`);
}

async function waitFor(what, check, seconds = 40) {
  for (let i = 0; i < seconds; i++) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fail(`${what} did not become ready within ${seconds}s. See: docker logs ${what}`);
}

async function sqld() {
  ensureContainer(SQLD.name, [
    "-p", `127.0.0.1:${SQLD.port}:8080`,
    "-p", `127.0.0.1:${SQLD.adminPort}:8081`,
    "-e", "SQLD_NODE=primary",
    "-e", "SQLD_ADMIN_LISTEN_ADDR=0.0.0.0:8081",
    "-v", `${SQLD.volume}:/var/lib/sqld`,
    SQLD_IMAGE, "/bin/sqld", "--enable-namespaces",
  ]);
  await waitFor(SQLD.name, async () => (await fetch(`http://localhost:${SQLD.port}/health`)).ok);
  // The app makes its own namespaces when it starts; this only shows the admin API answers.
  console.log(`sqld is up. Use:\n`);
  console.log(`  export SQLITE_URL=http://localhost:${SQLD.port}`);
  console.log(`  export SQLD_ADMIN_URL=http://localhost:${SQLD.adminPort}`);
}

async function postgres() {
  ensureContainer(POSTGRES.name, [
    "-p", `127.0.0.1:${POSTGRES.port}:5432`,
    "-e", "POSTGRES_USER=fjord",
    "-e", "POSTGRES_PASSWORD=fjord",
    "-e", "POSTGRES_DB=fjord",
    "-v", `${POSTGRES.volume}:/var/lib/postgresql/data`,
    POSTGRES_IMAGE,
  ]);
  await waitFor(POSTGRES.name, async () => docker("exec", POSTGRES.name, "pg_isready", "-U", "fjord", "-d", "fjord").status === 0);
  console.log(`PostgreSQL is up. Use:\n`);
  console.log(`  export DB_DIALECT=postgres`);
  console.log(`  export POSTGRES_DB_URL=postgres://fjord:fjord@localhost:${POSTGRES.port}/fjord`);
}

function stop() {
  for (const { name } of [SQLD, POSTGRES]) {
    if (stateOf(name) === "running") {
      docker("stop", name);
      console.log(`stopped ${name}`);
    }
  }
}

const command = process.argv[2];
if (command === "sqld" || command === "postgres" || command === "stop") {
  requireDocker();
  if (command === "sqld") await sqld();
  else if (command === "postgres") await postgres();
  else stop();
} else {
  fail("usage: pnpm db:dev sqld | postgres | stop");
}
