import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A stand-in for GitHub's REST API whose storage is a real git repository, answered with git's own
 * plumbing. Object ids, tree contents and the rule that a branch moves only by fast-forward are
 * therefore git's, and not what I believe git does. The routes are the subset Fjord Web uses, with
 * the shapes GitHub returns (checked against recorded real answers, `github.recorded.test.ts`).
 *
 * It is a test double: it can be told to answer badly (`fail`), to cut tree listings short, and to
 * have someone else push, so the provider's handling of each can be tested.
 */
export interface FakeGitHubOptions {
  owner?: string;
  name?: string;
  /** Tokens it accepts, and whether each may write. Default: `test-token`, which may. */
  tokens?: Record<string, { push: boolean }>;
  /** A port to listen on, for a test that has to tell another process where it is; default a free one. */
  port?: number;
}

interface Failure {
  match: RegExp;
  method?: string;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** How many requests it fails; default 1. */
  times: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body?: unknown;
}

const NULL_SHA = "0".repeat(40);

export class FakeGitHub {
  readonly requests: RecordedRequest[] = [];
  readonly ref: { owner: string; name: string };
  /** Cut recursive tree listings short past this many entries. */
  treeLimit: number | undefined;
  /** Refuse blobs past this size as GitHub does for ones it will not serve. */
  maxBlobBytes: number | undefined;
  /** Send listings in pages this small, whatever the client asks. */
  pageSize: number | undefined;

  private server!: Server;
  private dir!: string;
  private repo!: string;
  private failures: Failure[] = [];
  private hooks: { match: RegExp; method?: string; action: () => Promise<unknown> }[] = [];
  private lock: Promise<unknown> = Promise.resolve();
  private counter = 0;

  constructor(private readonly options: FakeGitHubOptions = {}) {
    this.ref = { owner: options.owner ?? "acme", name: options.name ?? "notes" };
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async start(): Promise<void> {
    this.dir = mkdtempSync(join(tmpdir(), "fjord-fake-github-"));
    this.repo = join(this.dir, "repo.git");
    mkdirSync(this.repo);
    await this.git(["init", "--bare", "--initial-branch=main", "--quiet"]);
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(this.options.port ?? 0, "127.0.0.1", resolve));
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** Run something, once, just before the next request that matches is handled: to make a race happen in the middle of a call. */
  before(match: RegExp, action: () => Promise<unknown>, method?: string): void {
    this.hooks.push({ match, action, ...(method ? { method } : {}) });
  }

  /** Answer the next requests that match with this failure instead of doing them. */
  fail(match: RegExp, response: { status: number; headers?: Record<string, string>; body?: unknown; method?: string; times?: number }): void {
    this.failures.push({ match, times: 1, ...response });
  }

  // --- Setting up, straight into git (not through the API) ---------------------------------

  /** Commit these files to the branch on top of what is there; `null` deletes. With `replace`, the branch holds exactly these. */
  async commitFiles(files: Record<string, string | Uint8Array | null>, options: { branch?: string; replace?: boolean; message?: string } = {}): Promise<string> {
    const branch = options.branch ?? "main";
    const parent = await this.revParse(`refs/heads/${branch}`);
    const index = this.newIndex();
    if (parent && !options.replace) await this.git(["read-tree", parent], { index });
    else await this.git(["read-tree", "--empty"], { index });
    const lines: string[] = [];
    for (const [path, content] of Object.entries(files)) {
      if (content === null) {
        lines.push(`0 ${NULL_SHA}\t${path}`);
      } else {
        const sha = await this.hashObject(typeof content === "string" ? Buffer.from(content) : Buffer.from(content));
        lines.push(`100644 ${sha}\t${path}`);
      }
    }
    await this.git(["update-index", "--index-info"], { index, input: `${lines.join("\n")}\n` });
    const tree = (await this.git(["write-tree"], { index })).toString().trim();
    const commit = await this.commitTree(tree, parent ? [parent] : [], options.message ?? `commit ${++this.counter}`, { name: "Someone", email: "someone@example.com" });
    await this.git(["update-ref", `refs/heads/${branch}`, commit]);
    return commit;
  }

  /** What git itself says about a commit, for asserting on what the provider wrote. */
  async show(commit: string, format: string): Promise<string> {
    return (await this.git(["show", "--no-patch", `--format=${format}`, commit])).toString().trimEnd();
  }

  async branchHead(branch = "main"): Promise<string | undefined> {
    return this.revParse(`refs/heads/${branch}`);
  }

  async fsck(): Promise<void> {
    await this.git(["fsck", "--strict", "--no-dangling"]);
  }

  async filesAt(commit: string): Promise<Record<string, string>> {
    const listing = (await this.git(["ls-tree", "-r", "-z", commit])).toString("utf8").split("\0").filter(Boolean);
    const files: Record<string, string> = {};
    for (const line of listing) {
      const [meta, path] = line.split("\t");
      files[path!] = (await this.git(["cat-file", "blob", meta!.split(" ")[2]!])).toString("utf8");
    }
    return files;
  }

  /** One file at a commit, as the bytes git holds (`filesAt` reads text; an encrypted file is not). */
  async fileBytesAt(commit: string, path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.git(["cat-file", "blob", `${commit}:${path}`]));
  }

  // --- HTTP --------------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const path = url.pathname;
    const method = req.method ?? "GET";
    const raw = await readBody(req);
    const body = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : undefined;
    this.requests.push({ method, path: path + url.search, headers: req.headers, ...(body !== undefined ? { body } : {}) });

    const reply = (status: number, payload?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "x-github-request-id": `FAKE${this.requests.length}`, ...headers });
      res.end(payload === undefined ? undefined : JSON.stringify(payload));
    };

    const hook = this.hooks.find((entry) => entry.match.test(path) && (!entry.method || entry.method === method));
    if (hook) {
      this.hooks.splice(this.hooks.indexOf(hook), 1);
      await hook.action();
    }

    const failure = this.failures.find((f) => f.match.test(path) && (!f.method || f.method === method));
    if (failure) {
      if (--failure.times <= 0) this.failures.splice(this.failures.indexOf(failure), 1);
      return reply(failure.status, failure.body ?? { message: "Injected failure" }, failure.headers);
    }

    const token = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
    const tokens = this.options.tokens ?? { "test-token": { push: true } };
    const grant = token ? tokens[token] : undefined;
    if (!grant) return reply(401, { message: "Bad credentials", documentation_url: "https://docs.github.com/rest" });

    try {
      await this.route(method, path, url, body, grant, req, res, reply);
    } catch (error) {
      reply(500, { message: error instanceof Error ? error.message : "fake failed" });
    }
  }

  private async route(
    method: string,
    path: string,
    url: URL,
    body: any, // eslint-disable-line @typescript-eslint/no-explicit-any -- a request body, whatever the client sent
    grant: { push: boolean },
    req: IncomingMessage,
    res: ServerResponse,
    reply: (status: number, payload?: unknown, headers?: Record<string, string>) => void,
  ): Promise<void> {
    const repoJson = () => ({ name: this.ref.name, owner: { login: this.ref.owner }, default_branch: "main", private: true, permissions: { push: grant.push, pull: true } });

    if (method === "GET" && (path === "/user/repos" || path === "/installation/repositories")) {
      const all = [repoJson()];
      const size = this.pageSize ?? Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      const slice = all.slice((page - 1) * size, page * size);
      const next: Record<string, string> = page * size < all.length ? { link: `<${this.url}${path}?per_page=${size}&page=${page + 1}>; rel="next"` } : {};
      return reply(200, path === "/user/repos" ? slice : { total_count: all.length, repositories: slice }, next);
    }

    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (!m || m[1] !== this.ref.owner || m[2] !== this.ref.name) return reply(404, { message: "Not Found" });
    const rest = m[3] ?? "";
    if (method === "GET" && rest === "") return reply(200, repoJson());

    const writes = method !== "GET";
    if (writes && !grant.push) return reply(403, { message: "Resource not accessible by personal access token" });

    let found: RegExpExecArray | null;
    if (method === "GET" && (found = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
      const sha = await this.revParse(`refs/heads/${decodeURIComponent(found[1]!)}`);
      if (!sha) return reply(404, { message: "Not Found" });
      const etag = `W/"${sha}"`;
      if (req.headers["if-none-match"] === etag) return reply(304, undefined, { etag });
      return reply(200, { ref: `refs/heads/${found[1]}`, object: { sha, type: "commit" } }, { etag });
    }

    if (method === "GET" && (found = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest))) {
      if (!(await this.exists(found[1]!, "commit"))) return reply(404, { message: "Not Found" });
      const tree = (await this.git(["rev-parse", `${found[1]}^{tree}`])).toString().trim();
      return reply(200, { sha: found[1], tree: { sha: tree } });
    }

    if (method === "GET" && (found = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest))) {
      if (!(await this.exists(found[1]!))) return reply(404, { message: "Not Found" });
      const recursive = url.searchParams.has("recursive");
      const out = (await this.git(["ls-tree", ...(recursive ? ["-r", "-t"] : []), "-l", "-z", found[1]!])).toString("utf8").split("\0").filter(Boolean);
      let tree = out.map((line) => {
        const [meta, path] = line.split("\t");
        const [mode, type, sha, size] = meta!.trim().split(/\s+/);
        return { path, mode, type, sha, ...(type === "blob" ? { size: Number(size) } : {}) };
      });
      let truncated = false;
      if (recursive && this.treeLimit !== undefined && tree.length > this.treeLimit) {
        tree = tree.slice(0, this.treeLimit);
        truncated = true;
      }
      return reply(200, { sha: found[1], tree, truncated });
    }

    if (method === "GET" && (found = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest))) {
      if (!(await this.exists(found[1]!, "blob"))) return reply(404, { message: "Not Found" });
      const content = await this.git(["cat-file", "blob", found[1]!]);
      if (this.maxBlobBytes !== undefined && content.length > this.maxBlobBytes) {
        return reply(403, { message: "The requested blob is too large to fetch via the API", errors: [{ resource: "Blob", field: "data", code: "too_large" }] });
      }
      if (String(req.headers.accept).includes("raw")) {
        res.writeHead(200, { "content-type": "application/vnd.github.raw+json", "content-length": String(content.length) });
        return void res.end(content);
      }
      return reply(200, { sha: found[1], size: content.length, encoding: "base64", content: content.toString("base64") });
    }

    // Writes go one at a time, as a repository's would.
    if (method === "POST" && rest === "/git/blobs") {
      const content = body.encoding === "base64" ? Buffer.from(body.content, "base64") : Buffer.from(body.content, "utf8");
      return reply(201, { sha: await this.hashObject(content) });
    }

    if (method === "POST" && rest === "/git/trees") {
      const index = this.newIndex();
      if (body.base_tree) {
        if (!(await this.exists(body.base_tree, "tree"))) return reply(422, { message: "GitRPC::BadObjectState" });
        await this.git(["read-tree", body.base_tree], { index });
      } else {
        await this.git(["read-tree", "--empty"], { index });
      }
      const lines: string[] = [];
      for (const entry of body.tree as { path: string; mode: string; sha: string | null }[]) {
        if (entry.sha === null) {
          lines.push(`0 ${NULL_SHA}\t${entry.path}`);
        } else {
          if (!(await this.exists(entry.sha, "blob"))) return reply(422, { message: "GitRPC::BadObjectState" });
          lines.push(`${entry.mode} ${entry.sha}\t${entry.path}`);
        }
      }
      await this.git(["update-index", "--index-info"], { index, input: `${lines.join("\n")}\n` });
      const sha = (await this.git(["write-tree"], { index })).toString().trim();
      return reply(201, { sha });
    }

    if (method === "POST" && rest === "/git/commits") {
      if (!(await this.exists(body.tree, "tree"))) return reply(422, { message: "Tree SHA does not exist" });
      for (const parent of body.parents ?? []) if (!(await this.exists(parent, "commit"))) return reply(422, { message: "Parent does not exist" });
      const commit = await this.commitTree(body.tree, body.parents ?? [], body.message, body.author ?? { name: "Fake GitHub", email: "fake@example.com" });
      return reply(201, { sha: commit });
    }

    if (method === "PATCH" && (found = /^\/git\/refs\/heads\/(.+)$/.exec(rest))) {
      const ref = `refs/heads/${decodeURIComponent(found[1]!)}`;
      return this.serialised(async () => {
        const current = await this.revParse(ref);
        if (!current) return reply(422, { message: "Reference does not exist" });
        if (!(await this.exists(body.sha, "commit"))) return reply(422, { message: "Object does not exist" });
        if (body.force !== true) {
          const fastForward = await this.git(["merge-base", "--is-ancestor", current, body.sha]).then(() => true, () => false);
          if (!fastForward) return reply(422, { message: "Update is not a fast forward" });
        }
        await this.git(["update-ref", ref, body.sha, current]);
        return reply(200, { ref, object: { sha: body.sha, type: "commit" } });
      });
    }

    return reply(404, { message: "Not Found", documentation_url: "https://docs.github.com/rest" });
  }

  // --- git ---------------------------------------------------------------------------------

  private serialised<T>(work: () => Promise<T>): Promise<T> {
    const run = this.lock.then(work, work);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private newIndex(): string {
    return join(this.dir, `index-${++this.counter}`);
  }

  private async revParse(ref: string): Promise<string | undefined> {
    try {
      return (await this.git(["rev-parse", "--verify", "--quiet", ref])).toString().trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async exists(sha: string, type?: string): Promise<boolean> {
    if (!/^[0-9a-f]{40}$/.test(sha)) return false;
    try {
      const actual = (await this.git(["cat-file", "-t", sha])).toString().trim();
      return type === undefined || actual === type || (type === "tree" && actual === "commit");
    } catch {
      return false;
    }
  }

  private async hashObject(content: Buffer): Promise<string> {
    return (await this.git(["hash-object", "-w", "--stdin"], { input: content })).toString().trim();
  }

  private async commitTree(tree: string, parents: string[], message: string, author: { name: string; email: string }): Promise<string> {
    const args = ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent])];
    const env = {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: "Fake GitHub",
      GIT_COMMITTER_EMAIL: "fake@example.com",
    };
    return (await this.git(args, { input: message, env })).toString().trim();
  }

  private git(args: string[], options: { index?: string; input?: Buffer | string; env?: Record<string, string> } = {}): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const env: Record<string, string> = {
          PATH: process.env.PATH ?? "",
          HOME: this.dir,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
          ...(options.index ? { GIT_INDEX_FILE: options.index } : {}),
          ...options.env,
      };
      const child: ChildProcessWithoutNullStreams = spawn("git", args, { cwd: this.repo, env: env as NodeJS.ProcessEnv });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`git ${args.join(" ")} exited ${code}: ${Buffer.concat(err).toString().trim()}`))));
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input);
    });
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
