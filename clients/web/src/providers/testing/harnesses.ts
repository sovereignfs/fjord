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
    async pushElsewhere(files) {
      return provider.seed(repo, files);
    },
    limitTree: (n) => provider.setTreeLimit(n),
    close: async () => undefined,
  };
}
