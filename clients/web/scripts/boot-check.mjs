// Start a built instance of the app against whatever database the environment names,
// and ask it whether it is up. This is the check that "a fresh instance boots from the
// documented variables" (ROADMAP 1a.0): the server provisions and migrates the database
// itself at start-up, so all it is given is DB_DIALECT, SQLITE_URL / SQLD_ADMIN_URL or
// POSTGRES_DB_URL, exactly as an operator would.
//
//   pnpm build && pnpm boot-check
//
// Exits 0 if /api/health answers ok on the expected dialect, 1 otherwise.
import { spawn } from "node:child_process";

const port = process.env.BOOT_CHECK_PORT ?? "3999";
const expectedDialect = (process.env.DB_DIALECT || "sqlite").toLowerCase();
const deadline = Date.now() + Number(process.env.BOOT_CHECK_TIMEOUT_MS ?? 90_000);

const server = spawn("pnpm", ["exec", "next", "start", "--port", port], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: port },
});
let log = "";
server.stdout.on("data", (chunk) => (log += chunk));
server.stderr.on("data", (chunk) => (log += chunk));
let exited = false;
server.on("exit", () => (exited = true));

function finish(code, message) {
  console.log(message);
  if (code !== 0) console.log(`--- server output ---\n${log}`);
  server.kill("SIGTERM");
  // Give it a moment to close its database connections before the process ends.
  setTimeout(() => process.exit(code), 500);
}

while (Date.now() < deadline) {
  if (exited) finish(1, "the server exited before it answered");
  try {
    const response = await fetch(`http://localhost:${port}/api/health`);
    const body = await response.json();
    if (response.ok && body.status === "ok") {
      if (body.database?.dialect !== expectedDialect) {
        finish(1, `booted, but on ${body.database?.dialect}, not ${expectedDialect}: ${JSON.stringify(body)}`);
      } else {
        finish(0, `booted: ${JSON.stringify(body)}`);
      }
      break;
    }
    // The server is up but its database is not ready or failed: not yet, or never.
    if (response.status === 503 && /ready|migrations applied/.test(log) === false && Date.now() + 5000 > deadline) {
      finish(1, `the server answered 503: ${JSON.stringify(body)}`);
      break;
    }
  } catch {
    // Not listening yet.
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (Date.now() >= deadline) finish(1, "timed out waiting for /api/health");
