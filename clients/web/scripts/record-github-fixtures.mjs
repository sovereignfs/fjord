// Record real answers from GitHub's REST API, for the tests that replay them
// (src/providers/github/github.recorded.test.ts).
//
//   node scripts/record-github-fixtures.mjs                    # everything
//   node scripts/record-github-fixtures.mjs --additions        # only a commit's build status and the branch listing, added to the fixture that is there
//
// It reads a public repository, sovereignfs/fjord, with no credential at all, so it spends the
// anonymous limit (60 requests an hour; this makes 13) and cannot leak anything. `--additions` makes 4 (and one more for each
// deployment the commit has) and keeps every other recorded answer as it is: the recorded tests assert on that commit's tree. The answers are
// saved exactly as GitHub sent them, headers trimmed to the few the provider reads. Re-run it to
// see whether GitHub's shapes have changed, and read the diff before committing: a test that
// replays a changed shape is telling you something.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.github.com';
const REPO = '/repos/sovereignfs/fjord';
const HEADERS = {
  'user-agent': 'fjord-web-fixture-recorder',
  'x-github-api-version': '2022-11-28',
};
const KEPT = ['etag', 'content-type', 'link'];

const record = [];

async function get(path, { accept = 'application/vnd.github+json', binary = false } = {}) {
  const response = await fetch(`${API}${path}`, { headers: { ...HEADERS, accept } });
  const headers = Object.fromEntries(
    KEPT.filter((name) => response.headers.has(name)).map((name) => [
      name,
      response.headers.get(name),
    ]),
  );
  const entry = { method: 'GET', path, accept, status: response.status, headers };
  if (binary) entry.bodyBase64 = Buffer.from(await response.arrayBuffer()).toString('base64');
  else entry.body = await response.json();
  record.push(entry);
  return entry;
}

const out = join(
  dirname(fileURLToPath(import.meta.url)),
  '../src/providers/github/fixtures/sovereignfs-fjord.json',
);

/**
 * What the host reports of a commit's build (ROADMAP 3c.3): check runs, commit statuses, deployments and each deployment's statuses; and the
 * listing of branches by a prefix (3d.1), which GitHub matches as a string and not by path segments.
 */
async function recordBuild(commit) {
  await get(`${REPO}/git/matching-refs/heads/ma?per_page=100`);
  await get(`${REPO}/commits/${commit}/check-runs?per_page=100`);
  await get(`${REPO}/commits/${commit}/status?per_page=100`);
  const deployments = await get(`${REPO}/deployments?sha=${commit}&per_page=10`);
  for (const deployment of (deployments.body ?? []).slice(0, 5))
    await get(`${REPO}/deployments/${deployment.id}/statuses?per_page=1`);
}

if (process.argv.includes('--additions')) {
  if (!existsSync(out)) throw new Error(`${out} is not there: record everything first`);
  const fixture = JSON.parse(readFileSync(out, 'utf8'));
  await recordBuild(fixture.commit);
  const kept = fixture.record.filter(
    (old) =>
      !/\/(commits\/[0-9a-f]{40}\/(check-runs|status)|deployments|git\/matching-refs)/.test(
        old.path,
      ),
  );
  writeFileSync(out, `${JSON.stringify({ ...fixture, record: [...kept, ...record] }, null, 1)}\n`);
  console.log(
    `recorded ${record.length} additional answers for ${fixture.commit.slice(0, 7)} into ${out}`,
  );
  process.exit(0);
}

await get(REPO);
const ref = await get(`${REPO}/git/ref/heads/main`);
const commit = ref.body.object.sha;
const recursive = await get(`${REPO}/git/trees/${commit}?recursive=1`);
await get(`${REPO}/git/trees/${commit}`);
const crates = recursive.body.tree.find(
  (entry) => entry.path === 'crates' && entry.type === 'tree',
);
await get(`${REPO}/git/trees/${crates.sha}`);
const readme = recursive.body.tree.find(
  (entry) => entry.path === 'README.md' && entry.type === 'blob',
);
await get(`${REPO}/git/blobs/${readme.sha}`, {
  accept: 'application/vnd.github.raw+json',
  binary: true,
});
await get(`${REPO}/git/ref/heads/there-is-no-such-branch`);
await get('/repos/sovereignfs/there-is-no-such-repository');
await recordBuild(commit);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  `${JSON.stringify({ recordedAt: new Date().toISOString(), commit, record }, null, 1)}\n`,
);
console.log(`recorded ${record.length} answers at ${commit.slice(0, 7)} into ${out}`);
