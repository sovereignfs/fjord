// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The nonce the page's own scripts were given, if the page has a Content-Security-Policy with one (clients/web/DESIGN.md §15).
 *
 * CodeMirror makes its stylesheet at run time, as a `<style>` element, and under a policy that allows style elements only with the page's nonce it
 * is blocked unless it carries it, which leaves the editor unstyled (its text no longer wraps and keeps its spaces, and Chrome then types non-breaking
 * ones). A client should not have to hand the nonce through every screen that has an editor, so the editor finds it where the browser keeps it: on the
 * scripts the server marked. (The attribute itself is hidden once a page is parsed; the `nonce` property is not.) A page with no policy has none, and
 * the editor then adds none.
 */
export function pageNonce(doc: Document = document): string | undefined {
  const script = doc.querySelector<HTMLScriptElement>("script[nonce]");
  const nonce = script?.nonce || script?.getAttribute("nonce") || "";
  return nonce === "" ? undefined : nonce;
}
