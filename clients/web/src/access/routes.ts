import type { Action } from "./policy";

/**
 * Every page and API route of the app, and who may use it (DESIGN.md §12, ROADMAP 1c.1). A route that is not here, or
 * is here with a method it does not have, fails `routes.test.ts`, so a new endpoint cannot be added without saying who may
 * call it, and a decision in this table cannot outlive the route.
 *
 *  - `public`: anyone, signed in or not. It shows nothing that belongs to an account.
 *  - `account`: a signed-in account, and only its own data (its connections, its settings). Another's is a 404.
 *  - `resource`: something that belongs to a connection's owner, done for the `action` the policy names (`policy.ts`). Most of these
 *    routes are keyed by the connection, which a share never holds, so only its owner is let in. A share is let in at the
 *    routes keyed by a document: `/doc/<id>/draft` is the first (a link's holder edits, 1c.6), and the comments' come with 1d. The action
 *    each asks is named in the same way, so the policy, not the route, says which role may.
 */
export type RouteAccess =
  | { kind: "public" }
  | { kind: "account" }
  | { kind: "resource"; action: Action };

export interface RouteRule {
  /** The route as the app router spells it: `/api/connections/[id]/files`. */
  route: string;
  /** For an API route, each method it answers. A page has none. */
  methods?: Record<string, RouteAccess>;
  /** For a page. */
  page?: RouteAccess;
}

const owner = (action: Action): RouteAccess => ({ kind: "resource", action });

export const ROUTES: RouteRule[] = [
  // Pages
  { route: "/", page: { kind: "public" } },
  { route: "/sign-in", page: { kind: "public" } },
  { route: "/sign-in/two-factor", page: { kind: "public" } },
  { route: "/sign-up", page: { kind: "public" } },
  { route: "/forgot-password", page: { kind: "public" } },
  { route: "/reset-password", page: { kind: "public" } },
  { route: "/home", page: { kind: "account" } },
  { route: "/repositories", page: { kind: "account" } },
  { route: "/account/security", page: { kind: "account" } },
  // The age identity kept in the browser (2a.1): the page only hosts the component that keeps it; the server holds and is asked for nothing of it.
  { route: "/account/keys", page: { kind: "account" } },
  // A repository, a folder, a file; a document or note by its id; and what was deleted from it.
  { route: "/repo/[connection]/[[...path]]", page: owner("read") },
  { route: "/doc/[id]", page: owner("read") },
  // A guest edits through a link's cookie, which is sent under `/doc/<id>` and nowhere else (1c.4, 1c.6): the first route a share reaches, so the policy's `edit` is its action.
  { route: "/doc/[id]/draft", methods: { PUT: owner("edit") } },
  // Comments on a document: read by anyone let in, the rest by what the policy gives each role (1d.1). Each method names the weakest action it may be; the operation inside asks its own.
  { route: "/doc/[id]/comments", methods: { GET: owner("read"), POST: owner("comment"), PATCH: owner("resolve"), DELETE: owner("delete_own_comment") } },
  // The live stream of a document's comments: says that they changed, never what they are; who may watch is who may read them (1d.3).
  { route: "/doc/[id]/comments/events", methods: { GET: owner("read") } },
  { route: "/note/[id]", page: owner("read") },
  { route: "/deleted/[connection]", page: owner("restore") },

  // APIs
  { route: "/api/health", methods: { GET: { kind: "public" } } },
  { route: "/api/auth/[...all]", methods: { GET: { kind: "public" }, POST: { kind: "public" } } },
  // Entering by a share link: the proxy sends `/doc/<id>?token=` here for the cookie and the redirect (1c.4); a token that works is the only way in.
  { route: "/api/links/enter", methods: { GET: { kind: "public" } } },
  // Installing the GitHub App (1a.6): a signed-in person leaves for GitHub and comes back, with a `state` this browser was given. The webhook is GitHub's, not a person's: it is let in by its signature alone.
  { route: "/api/github-app/install", methods: { GET: { kind: "account" } } },
  { route: "/api/github-app/callback", methods: { GET: { kind: "account" } } },
  { route: "/api/webhooks/github", methods: { POST: { kind: "public" } } },
  { route: "/api/connections", methods: { GET: { kind: "account" }, POST: { kind: "account" } } },
  { route: "/api/connections/[id]", methods: { DELETE: { kind: "account" } } },
  { route: "/api/connections/[id]/default", methods: { POST: { kind: "account" } } },
  { route: "/api/connections/[id]/vault", methods: { PUT: { kind: "account" } } },
  { route: "/api/connections/[id]/setup", methods: { POST: { kind: "account" } } },
  { route: "/api/connections/[id]/files", methods: { POST: owner("create") } },
  // The stored bytes of an encrypted file, for the browser to decrypt (2b.2). A read, so the owner's `read`; the server holds no key to them.
  { route: "/api/connections/[id]/ciphertext", methods: { GET: owner("read") } },
  { route: "/api/connections/[id]/recipients", methods: { GET: owner("read") } },
  { route: "/api/connections/[id]/files/encrypted", methods: { POST: owner("create") } },
  { route: "/api/connections/[id]/files/transfer", methods: { POST: owner("move") } },
  { route: "/api/connections/[id]/files/header", methods: { POST: owner("edit") } },
  { route: "/api/connections/[id]/files/delete", methods: { POST: owner("delete") } },
  { route: "/api/connections/[id]/files/move", methods: { POST: owner("move") } },
  { route: "/api/connections/[id]/files/restore", methods: { POST: owner("restore") } },
  { route: "/api/connections/[id]/shares", methods: { GET: owner("manage_shares"), POST: owner("manage_shares"), DELETE: owner("manage_shares") } },
  { route: "/api/connections/[id]/links", methods: { GET: owner("manage_shares"), POST: owner("manage_shares"), PATCH: owner("manage_shares"), DELETE: owner("manage_shares") } },
  { route: "/api/connections/[id]/working-copy", methods: { PUT: owner("edit"), DELETE: owner("edit") } },
  { route: "/api/connections/[id]/working-copy/version", methods: { POST: owner("save_version") } },
  { route: "/api/connections/[id]/working-copy/resolve", methods: { POST: owner("edit") } },
];
