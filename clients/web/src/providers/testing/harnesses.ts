import { GitHubProvider } from "../github/provider";
import { MemoryProvider } from "../memory";
import type { ProviderHarness } from "./contract";
import { FakeGitHub } from "./fake-github";

/** GitHub's provider, talking to a fake GitHub whose repository is a real git repository. */
export async function githubHarness(): Promise<ProviderHarness & { fake: FakeGitHub }> {
  const fake = new FakeGitHub({ tokens: { "test-token": { push: true }, "read-only": { push: false } } });
  await fake.start();
  const as = (token: string) =>
    new GitHubProvider({ apiUrl: fake.url, token: async () => token, scope: "user", sleep: async () => undefined });
  return {
    fake,
    provider: as("test-token"),
    repo: fake.ref,
    seed: (files) => fake.commitFiles(files, { replace: true }),
    reportBuild: (commit, report) => {
      // A neutral report, as GitHub holds it: each check a check run, and a site a successful deployment with its address.
      fake.reportBuild(commit, {
        checkRuns: report.checks.map((check) => ({
          name: check.name,
          status: check.state === "pending" ? "in_progress" : "completed",
          conclusion: check.state === "pending" ? null : check.state === "success" ? "success" : "failure",
          html_url: check.url ?? null,
        })),
        deployments: report.siteUrl ? [{ id: 1 + Math.floor(Math.random() * 1e6), environment: "preview", statuses: [{ state: "in_progress" }, { state: "success", environment_url: report.siteUrl }] }] : [],
      });
    },
    pushElsewhere: (files) => fake.commitFiles(files),
    limitTree: (n) => {
      fake.treeLimit = n;
    },
    rateLimitNext: (resetAt) =>
      fake.fail(/.*/, {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(resetAt.getTime() / 1000)) },
        body: { message: "API rate limit exceeded for installation." },
      }),
    readOnly: () => as("read-only"),
    revoked: () => as("revoked-token"),
    close: () => fake.stop(),
  };
}

/** The in-memory provider, with the one repository the contract uses. */
export async function memoryHarness(): Promise<ProviderHarness> {
  const provider = new MemoryProvider();
  const repo = { owner: "acme", name: "notes" };
  provider.createRepository(repo);
  return {
    provider,
    repo,
    async seed(files) {
      return provider.seed(repo, files, { replace: true });
    },
    reportBuild: (commit, report) => provider.reportBuild(repo, commit, report),
    async pushElsewhere(files) {
      return provider.seed(repo, files);
    },
    limitTree: (n) => provider.setTreeLimit(n),
    close: async () => undefined,
  };
}
