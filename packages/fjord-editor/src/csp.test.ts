// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, it } from "vitest";
import { pageNonce } from "./csp.js";
import { createState } from "./note-state.js";
import { EditorView } from "@codemirror/view";

/** The editor under a Content-Security-Policy that allows style elements only with the page's nonce (clients/web/DESIGN.md §15, ROADMAP 1d.5). */
afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

const pageWithNonce = (nonce: string) => {
  const script = document.createElement("script");
  script.setAttribute("nonce", nonce);
  document.head.append(script);
};
const options = { readOnly: false, label: "note", isReadOnly: () => false, onEdit: () => undefined };

describe("the page's nonce", () => {
  it("is the one its scripts were given, and nothing for a page that has none", () => {
    expect(pageNonce()).toBeUndefined();
    pageWithNonce("abc123==");
    expect(pageNonce()).toBe("abc123==");
  });

  it("is nothing for a script with an empty one", () => {
    pageWithNonce("");
    expect(pageNonce()).toBeUndefined();
  });
});

describe("the note editor's stylesheet", () => {
  it("carries the page's nonce, so that a policy which allows style elements only with it lets the editor be styled", () => {
    pageWithNonce("abc123==");
    const parent = document.body.appendChild(document.createElement("div"));
    const view = new EditorView({ parent, state: createState("hello", options) });
    const styles = [...document.querySelectorAll("style")];
    expect(styles.length).toBeGreaterThan(0);
    for (const style of styles) expect(style.nonce || style.getAttribute("nonce")).toBe("abc123==");
    view.destroy();
  });
});
