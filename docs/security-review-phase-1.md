# Fjord Web — security review of phase 1

The review of ROADMAP task 1d.5 ([`docs/epics/web-1d.md`](epics/web-1d.md)): what [`clients/web/DESIGN.md`](../clients/web/DESIGN.md) §15 promises, tried against the running app,
what was found, what was done and what was left. Each promise that holds is a test, and each test was seen to fail with the protection switched off. This is a record of one
review at one time (October 2026); the promises themselves stay in the design.

The review went through what §15 promises, against the running app and not the code alone, and turned each promise into a test that was seen to fail with the
protection switched off. What it found, and what was done:

**The Content-Security-Policy** (`src/security/csp.ts`, sent by `proxy.ts` with a nonce made for each request): scripts run only with the nonce (or from a script
that has it, `'strict-dynamic'`), so an inline handler, a `javascript:` address or a script put in by content does not run; style *elements* need the nonce too, and
style *attributes* are allowed (the document editor needs them, and an attribute cannot run anything); images, fonts and requests are this origin's own, so nothing
third-party loads; nobody may frame a page; forms go only here; `upgrade-insecure-requests` and HSTS only where the instance's address is https. Also sent on every
response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`, `Referrer-Policy: no-referrer`.
Every page is therefore rendered for each request (a nonce cannot be prerendered), the landing page too. The browser test opens the app's pages, menus and dialogs
for an owner and for a guest and fails on any blocked request, and puts hostile markup into a page to see it refused.

| # | Finding | Outcome |
| --- | --- | --- |
| 1 | No Content-Security-Policy or other security headers were sent. | **Fixed**, above. |
| 2 | Under that policy CodeMirror's run-time stylesheet was blocked, leaving the note editor unstyled (lines unwrapped, spaces typed as non-breaking ones). Found by the browser tests, not by looking. | **Fixed**: the editor takes the page's nonce from its scripts (`fjord-editor` `csp.ts`). |
| 3 | Two `<style>` elements of the document editor's select menu (Radix) cannot be given a nonce. | **Allowed by hash** (`LIBRARY_STYLE_HASHES`); an upgrade of either library that changes the text is blocked until its hash is updated, and the browser test notices. |
| 4 | `proxy.test.ts` (the share link's entry) was not in the test run's include, so it had not been running; two of its expectations were stale. | **Fixed**. |
| 5 | A password change ending the other sessions (§15) was claimed and untested; so was a hostile redirect address on the auth endpoints. | **Tested** (both hold). |
| 6 | The health check logged the whole error, which may carry a host or connection string. | **Fixed**: the log has its name only. |
| 7 | Whether every route refuses what it should was tested route by route, not for the app as a whole. | **Tested** from the registry (`src/access/routes.ts`): every route that changes something refuses another site's request, with no origin, and `null`, even from its owner; every route refuses a caller with no account and one that owns nothing; nothing is changed by trying. A new route is in the registry or `routes.test.ts` fails, so it is in the matrix too. |
| 8 | Whether the git host's token or the instance's secrets can reach a browser was tested for pages, not for everything. | **Tested**: every page, script and answer for an owner and a guest, their cookies and storage, none holds them. |
| 9 | Sanitisation: nothing in the app renders content as HTML (no `dangerouslySetInnerHTML` but the theme script; the editors build their own nodes; comments and names are text), but it was not shown. | **Tested** with a document, a comment and a name made of script tags, handlers, `javascript:` addresses, remote images and frames: shown as text, nothing runs, no request goes to another site. |

**Recorded, not changed:**

- **Images from other sites do not load** in a document (`img-src 'self' data: blob:`): they would tell that site who read the document. A document's own images in
  the repository need Fjord to serve them (an image route with the same checks as the document), which is later work.
- **`'strict-dynamic'`** trusts scripts made by the page's own scripts. Content cannot make them; a bug in our own code that built a script from content could.
- **A guest's identity is spoofable** (§13, by design), and one who may comment can move the marks of other threads by many small moves (1d.2), as far as
  120 moves a minute allow. It changes nothing but where a mark is drawn; the comments stay where they are, and the owner can close, delete and revoke.
- **Rate limits** (1d.4) are fixed windows (up to twice the limit across an edge), by account, browser and link and not by network address, and reading is
  not limited except by the caps on live streams. The numbers are constants.
- **A revoked link's holder may be sent version numbers for up to fifteen seconds** by a live stream already open (never comments; the next read is refused).
- **Routes may look at a body before deciding a caller has no business there** (`400` for an empty body, where a valid one would be `404`): the answer is the same for a
  resource that exists and one that does not, so it tells a stranger nothing.
- **Open sign-up with no mail** has to say that an address is taken, or the person cannot tell why it failed; with email verification it says nothing (§15, tested).
- **`/api/health` is public** and says the database dialect and whether the format module loaded; the deployment checks use it, and it holds nothing secret.
- **Start-up failures print their message** to the operator's log; they name the setting that is wrong, not its value.
- **Sign-in limits depend on a proxy that sets the client's address** (§15, as before).
- **Not reviewed, because it does not exist yet:** encrypted files and identities in the browser (phase 2), real-time editing (phase 3), the worker (1b.13), webhooks (1a.6).
- **Not done in this review:** a penetration test by someone else. (The container image was built and run under the new headers in each of its three setups, and the deployment check now asserts the policy and the nonce on the image's own server.)
