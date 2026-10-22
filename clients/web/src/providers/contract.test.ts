import { providerContract } from "./testing/contract";
import { githubHarness, memoryHarness } from "./testing/harnesses";

// The same cases, against both: GitHub's provider over a fake whose storage is a real git
// repository, and the in-memory one.
providerContract("GitHub, over a git-backed fake", githubHarness, { truncation: true, credentials: true });
providerContract("in memory", memoryHarness, { truncation: true, credentials: false });
