import { type Server, createServer } from "node:http";
import { FakeGitHub } from "../src/providers/testing/fake-github";

/**
 * Two repositories on one "GitHub" address, which is all an instance can be told of (`FJORD_GITHUB_API_URL`):
 * two git-backed fakes, `acme/notes` and `acme/more`, behind a small router that sends each request to the
 * one the path names (and `/user/repos` to the first).
 */
export interface TwoGitHubs {
  notes: FakeGitHub;
  more: FakeGitHub;
  stop(): Promise<void>;
}

const FORWARDED = ["authorization", "accept", "content-type", "if-none-match", "x-github-api-version", "user-agent"];

export async function startTwoGitHubs(port: number, tokens: Record<string, { push: boolean }>): Promise<TwoGitHubs> {
  const notes = new FakeGitHub({ tokens, owner: "acme", name: "notes" });
  const more = new FakeGitHub({ tokens, owner: "acme", name: "more" });
  await Promise.all([notes.start(), more.start()]);

  const router: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const target = (req.url ?? "").startsWith("/repos/acme/more") ? more.url : notes.url;
      const headers: Record<string, string> = {};
      for (const name of FORWARDED) if (typeof req.headers[name] === "string") headers[name] = req.headers[name] as string;
      const upstream = await fetch(target + (req.url ?? "/"), { method: req.method, headers, ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}) });
      const out: Record<string, string> = {};
      upstream.headers.forEach((value, key) => {
        if (key !== "transfer-encoding" && key !== "content-length" && key !== "connection") out[key] = value;
      });
      res.writeHead(upstream.status, out);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    })().catch(() => {
      res.writeHead(502).end();
    });
  });
  await new Promise<void>((resolve) => router.listen(port, "127.0.0.1", resolve));

  return {
    notes,
    more,
    stop: async () => {
      await new Promise<void>((resolve) => router.close(() => resolve()));
      await Promise.all([notes.stop(), more.stop()]);
    },
  };
}
