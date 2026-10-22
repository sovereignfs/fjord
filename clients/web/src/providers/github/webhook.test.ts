import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isProviderError } from "../errors";
import { verifyGitHubWebhook } from "./webhook";

const SECRET = "a-shared-webhook-secret";
const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const push = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ ref: "refs/heads/main", before: "a".repeat(40), after: "b".repeat(40), deleted: false, repository: { full_name: "acme/notes" }, ...overrides });

const signed = (event: string, body: string, secret = SECRET) => ({ headers: { "X-Hub-Signature-256": sign(body, secret), "X-GitHub-Event": event }, body });

describe("a signed webhook", () => {
  it("reports a push to a branch: which repository, which branch, from where to where", () => {
    expect(verifyGitHubWebhook(signed("push", push()), SECRET)).toEqual({
      kind: "push",
      repository: { owner: "acme", name: "notes" },
      branch: "main",
      before: "a".repeat(40),
      after: "b".repeat(40),
      deleted: false,
    });
  });

  it("keeps a branch name with slashes whole, and says a deleted branch was deleted", () => {
    const event = verifyGitHubWebhook(signed("push", push({ ref: "refs/heads/feature/one", deleted: true })), SECRET);
    expect(event).toMatchObject({ kind: "push", branch: "feature/one", deleted: true });
  });

  it("answers a ping", () => {
    expect(verifyGitHubWebhook(signed("ping", JSON.stringify({ zen: "Keep it logically awesome." })), SECRET)).toEqual({ kind: "ping" });
  });

  it("ignores events it does not act on, and pushes that are not to a branch", () => {
    expect(verifyGitHubWebhook(signed("issues", "{}"), SECRET)).toEqual({ kind: "ignored", event: "issues" });
    expect(verifyGitHubWebhook(signed("push", push({ ref: "refs/tags/v1" })), SECRET).kind).toBe("ignored");
    expect(verifyGitHubWebhook(signed("push", push({ repository: { full_name: "no-slash" } })), SECRET).kind).toBe("ignored");
  });

  it("takes the body as a string or as bytes, and the headers as a Headers or an object in any case", () => {
    const body = push();
    const asHeaders = new Headers({ "x-hub-signature-256": sign(body), "X-GITHUB-EVENT": "push" });
    expect(verifyGitHubWebhook({ headers: asHeaders, body: new TextEncoder().encode(body) }, SECRET).kind).toBe("push");
    expect(verifyGitHubWebhook({ headers: { "x-hub-signature-256": sign(body), "x-github-event": "push" }, body }, SECRET).kind).toBe("push");
  });
});

describe("a webhook that is not trustworthy", () => {
  const refuses = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      expect(isProviderError(error, "invalid_webhook")).toBe(true);
      return;
    }
    throw new Error("expected the webhook to be refused");
  };

  it("is refused when it is signed with another secret", () => {
    refuses(() => verifyGitHubWebhook(signed("push", push(), "someone-elses-secret"), SECRET));
  });

  it("is refused when the body was changed after signing, even by one character", () => {
    const original = signed("push", push());
    refuses(() => verifyGitHubWebhook({ ...original, body: original.body.replace("main", "mait") }, SECRET));
  });

  it("is refused without a signature, with an empty one, or without the sha256= prefix", () => {
    const body = push();
    refuses(() => verifyGitHubWebhook({ headers: { "x-github-event": "push" }, body }, SECRET));
    refuses(() => verifyGitHubWebhook({ headers: { "x-hub-signature-256": "", "x-github-event": "push" }, body }, SECRET));
    refuses(() => verifyGitHubWebhook({ headers: { "x-hub-signature-256": sign(body).slice("sha256=".length), "x-github-event": "push" }, body }, SECRET));
    refuses(() => verifyGitHubWebhook({ headers: { "x-hub-signature": `sha1=${createHmac("sha1", SECRET).update(body).digest("hex")}`, "x-github-event": "push" }, body }, SECRET));
  });

  it("is refused when there is no secret to check against, rather than accepting anything", () => {
    refuses(() => verifyGitHubWebhook(signed("push", push(), ""), ""));
  });

  it("is refused before its contents are read: a correctly signed body that is not JSON is refused for that", () => {
    refuses(() => verifyGitHubWebhook(signed("push", "not json at all"), SECRET));
  });
});
