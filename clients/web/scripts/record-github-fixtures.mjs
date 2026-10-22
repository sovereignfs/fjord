// Record real answers from GitHub's REST API, for the tests that replay them
// (src/providers/github/github.recorded.test.ts).
//
//   node scripts/record-github-fixtures.mjs
//
// It reads a public repository, sovereignfs/fjord, with no credential at all, so it spends the
// anonymous limit (60 requests an hour; this makes 9) and cannot leak anything. The answers are
// saved exactly as GitHub sent them, headers trimmed to the few the provider reads. Re-run it to
// see whether GitHub's shapes have changed, and read the diff before committing: a test that
// replays a changed shape is telling you something.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.github.com";
const REPO = "/repos/sovereignfs/fjord";
const HEADERS = { "user-agent": "fjord-web-fixture-recorder", "x-github-api-version": "2022-11-28" };
const KEPT = ["etag", "content-type", "link"];

const record = [];

async function get(path, { accept = "application/vnd.github+json", binary = false } = {}) {
  const response = await fetch(`${API}${path}`, { headers: { ...HEADERS, accept } });
  const headers = Object.fromEntries(KEPT.filter((name) => response.headers.has(name)).map((name) => [name, response.headers.get(name)]));
  const entry = { method: "GET", path, accept, status: response.status, headers };
  if (binary) entry.bodyBase64 = Buffer.from(await response.arrayBuffer()).toString("base64");
  else entry.body = await response.json();
  record.push(entry);
  return entry;
}

await get(REPO);
const ref = await get(`${REPO}/git/ref/heads/main`);
const commit = ref.body.object.sha;
const recursive = await get(`${REPO}/git/trees/${commit}?recursive=1`);
await get(`${REPO}/git/trees/${commit}`);
const crates = recursive.body.tree.find((entry) => entry.path === "crates" && entry.type === "tree");
await get(`${REPO}/git/trees/${crates.sha}`);
const readme = recursive.body.tree.find((entry) => entry.path === "README.md" && entry.type === "blob");
await get(`${REPO}/git/blobs/${readme.sha}`, { accept: "application/vnd.github.raw+json", binary: true });
await get(`${REPO}/git/ref/heads/there-is-no-such-branch`);
await get("/repos/sovereignfs/there-is-no-such-repository");

const out = join(dirname(fileURLToPath(import.meta.url)), "../src/providers/github/fixtures/sovereignfs-fjord.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ recordedAt: new Date().toISOString(), commit, record }, null, 1)}\n`);
console.log(`recorded ${record.length} answers at ${commit.slice(0, 7)} into ${out}`);
