import { runMigrations } from "../db/migrate";
import { freshDatabase } from "../db/test-support";
import { MemoryMailer } from "../mail/mailer";
import { createAuth } from "./auth";
import type { EnabledAuthConfig, InstanceSettings, LocalSettings, SovereignSettings } from "./config";

/**
 * Everything a test of the sign-in flows needs: a better-auth instance on a freshly migrated
 * auth store (on whichever database the leg is running), the mail it sends, and a client that
 * talks to it the way a browser does: real requests with an Origin, and cookies kept between
 * them. Through `auth.handler`, so what is tested is the HTTP interface and not a shortcut.
 */
export interface TestAuth {
  auth: ReturnType<typeof createAuth>;
  config: EnabledAuthConfig;
  mailer?: MemoryMailer;
  database: Awaited<ReturnType<typeof freshDatabase>>["database"];
  client(): TestClient;
  close(): Promise<void>;
}

const INSTANCE: InstanceSettings = {
  url: "http://localhost:3000",
  secret: "test-secret-".padEnd(40, "x"),
  signUp: "closed",
  name: "Fjord",
};

const LOCAL: LocalSettings = {
  passwordMinLength: 10,
  passkeyRpId: "localhost",
  requireEmailVerification: false,
};

/**
 * What a test changes about the instance it gets. Local sign-in is on unless `local: false`;
 * the rest of the local settings are overrides of the defaults above. Sovereign is off unless
 * `sovereign` is given.
 */
export type AuthOverrides = Partial<InstanceSettings> & Partial<LocalSettings> & { local?: false; sovereign?: SovereignSettings };

export async function makeAuth(overrides: AuthOverrides = {}): Promise<TestAuth> {
  const { database } = await freshDatabase("auth");
  await runMigrations(database);
  const { local: noLocal, sovereign, url, secret, signUp, name, ...localOverrides } = overrides;
  const config: EnabledAuthConfig = {
    enabled: true,
    ...INSTANCE,
    ...(url !== undefined ? { url } : {}),
    ...(secret !== undefined ? { secret } : {}),
    ...(signUp !== undefined ? { signUp } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(noLocal === false ? {} : { local: { ...LOCAL, ...localOverrides } }),
    ...(sovereign ? { sovereign } : {}),
  };
  const mailer = config.local?.smtp ? new MemoryMailer() : undefined;
  const auth = createAuth({ config, database, ...(mailer ? { mailer } : {}) });
  return {
    auth,
    config,
    ...(mailer ? { mailer } : {}),
    database,
    client: () => new TestClient(auth, config.url),
    close: () => database.close(),
  };
}

export interface Reply {
  status: number;
  headers: Headers;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a test reads whatever shape better-auth answers with
  setCookies: string[];
}

/** A browser, in miniature: it keeps the cookies it is given and sends them back. */
export class TestClient {
  readonly jar = new Map<string, string>();

  constructor(
    private readonly auth: { handler(request: Request): Promise<Response> },
    private readonly origin: string,
    private readonly ip = "203.0.113.7",
  ) {}

  /** As another visitor, so that a rate limit on one address does not cross into another test. */
  from(ip: string): TestClient {
    const other = new TestClient(this.auth, this.origin, ip);
    for (const [k, v] of this.jar) other.jar.set(k, v);
    return other;
  }

  post(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    return this.request("POST", path, body, headers);
  }

  get(path: string, headers: Record<string, string> = {}): Promise<Reply> {
    return this.request("GET", path, undefined, headers);
  }

  /** Follow a full URL (a link from an email) as a GET, without following redirects. */
  follow(url: string): Promise<Reply> {
    const target = new URL(url);
    return this.request("GET", target.pathname + target.search, undefined, {});
  }

  has(cookieNameFragment: string): boolean {
    return [...this.jar.keys()].some((name) => name.includes(cookieNameFragment));
  }

  async request(method: string, path: string, body: unknown, headers: Record<string, string>): Promise<Reply> {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const request = new Request(new URL(path, this.origin), {
      method,
      redirect: "manual",
      headers: {
        origin: this.origin,
        "x-forwarded-for": this.ip,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const response = await this.auth.handler(request);
    const setCookies = response.headers.getSetCookie();
    for (const line of setCookies) {
      const [pair] = line.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      if (value === "" || /max-age=0/i.test(line)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      // not JSON (a redirect, say): leave it as text
    }
    return { status: response.status, headers: response.headers, body: parsed, setCookies };
  }
}

export { secretFromUri, totp } from "./totp";
