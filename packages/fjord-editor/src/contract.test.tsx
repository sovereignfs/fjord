// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type RenderResult, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentEditor } from "./DocumentEditor.js";
import { NoteEditor } from "./NoteEditor.js";
import { LABEL, type Surface, codeMirror, textArea } from "./testing/surfaces.js";
import type { Anchor, CommentsAdapter, DocumentEditorProps, EditorHandle, NoteEditorProps, ThreadMark } from "./types.js";

/**
 * What an editor in this package does, whatever is behind it. These are the tests that the text area standing in now,
 * CodeMirror (ROADMAP 1b.2) and MDXEditor (1b.3) must all pass: a change of core is a change of what is inside, and
 * these say what must not change.
 */
afterEach(cleanup);

// The document editor's surface is a text area until MDXEditor arrives (ROADMAP 1b.3); the note editor's is CodeMirror.
const box = () => textArea.element() as HTMLTextAreaElement;
const type = (text: string) => textArea.edit(text);

/** The app side of a controlled editor: it keeps the text, as the page will. */
function Harness({ initial = "Hello world", render: editor }: { initial?: string; render: (value: string, set: (value: string) => void) => React.ReactNode }) {
  const [value, setValue] = useState(initial);
  return <>{editor(value, setValue)}</>;
}

const documentIn = (props: Partial<DocumentEditorProps> & { role: DocumentEditorProps["role"] }, initial?: string) =>
  render(<Harness {...(initial !== undefined ? { initial } : {})} render={(value, set) => <DocumentEditor aria-label={LABEL} {...props} value={value} onChange={(next) => (props.onChange?.(next), set(next))} />} />);

const noteIn = (props: Partial<NoteEditorProps> = {}, initial?: string) =>
  render(<Harness {...(initial !== undefined ? { initial } : {})} render={(value, set) => <NoteEditor aria-label={LABEL} {...props} value={value} onChange={(next) => (props.onChange?.(next), set(next))} />} />);

const editors: { name: string; surface: Surface; editable: (onChange: (text: string) => void) => RenderResult; readOnly: (onChange: (text: string) => void) => RenderResult }[] = [
  {
    name: "DocumentEditor",
    surface: textArea,
    editable: (onChange) => documentIn({ role: "edit", onChange }),
    readOnly: (onChange) => documentIn({ role: "view", onChange }),
  },
  {
    name: "NoteEditor",
    surface: codeMirror,
    editable: (onChange) => noteIn({ onChange }),
    readOnly: (onChange) => noteIn({ readOnly: true, onChange }),
  },
];

describe.each(editors)("$name", ({ surface, editable, readOnly }) => {
  it("shows the text it is given, under the name it is given", () => {
    editable(() => undefined);
    expect(surface.text()).toBe("Hello world");
  });

  it("tells the app the whole new text after the person edits, and shows what the app then holds", async () => {
    const onChange = vi.fn();
    editable(onChange);
    surface.edit("Hello brave new world");
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith("Hello brave new world");
    await waitFor(() => expect(surface.text()).toBe("Hello brave new world"));
  });

  it("does not call onChange for a change the app made by setting the text", () => {
    const onChange = vi.fn();
    const make = (value: string) => (surface === codeMirror ? <NoteEditor aria-label={LABEL} value={value} onChange={onChange} /> : <DocumentEditor aria-label={LABEL} role="edit" value={value} onChange={onChange} />);
    const view = render(make("one"));
    view.rerender(make("two"));
    expect(surface.text()).toBe("two");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not change, or say it changed, when it may only be read", async () => {
    const onChange = vi.fn();
    readOnly(onChange);
    expect(surface.readOnly()).toBe(true);
    surface.edit("Something else");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onChange).not.toHaveBeenCalled();
    expect(surface.text()).toBe("Hello world");
  });

  it("says it can be changed when it can", () => {
    editable(() => undefined);
    expect(surface.readOnly()).toBe(false);
  });

  it("can be told to take focus", () => {
    const ref = createRef<EditorHandle>();
    render(surface === codeMirror ? <NoteEditor ref={ref} aria-label={LABEL} value="x" /> : <DocumentEditor ref={ref} aria-label={LABEL} role="edit" value="x" />);
    ref.current?.focus();
    expect(document.activeElement).toBe(surface.element());
  });
});

describe("a document editor's role", () => {
  it("lets `comment` read and select but not change the text", async () => {
    const onChange = vi.fn();
    documentIn({ role: "comment", onChange });
    expect(box().getAttribute("aria-readonly")).toBe("true");
    type("changed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("lets `edit` change it", () => {
    documentIn({ role: "edit" });
    expect(box().getAttribute("aria-readonly")).toBe("false");
  });
});

describe("asking an anonymous person for a name (onNeedName)", () => {
  it("asks before their first edit, and the edit goes through once they have given one", async () => {
    const onNeedName = vi.fn(async () => true);
    const onChange = vi.fn();
    documentIn({ role: "edit", onChange, onNeedName });
    expect(onNeedName).not.toHaveBeenCalled();

    type("first");
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("first"));
    expect(onNeedName).toHaveBeenCalledTimes(1);

    // Having a name, they are not asked again.
    type("second");
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("second"));
    expect(onNeedName).toHaveBeenCalledTimes(1);
  });

  it("makes no change when they decline, and asks again at their next attempt", async () => {
    let answer = false;
    const onNeedName = vi.fn(async () => answer);
    const onChange = vi.fn();
    documentIn({ role: "edit", onChange, onNeedName });

    type("declined");
    await waitFor(() => expect(onNeedName).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onChange).not.toHaveBeenCalled();
    expect(box().value).toBe("Hello world");

    answer = true;
    type("accepted");
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("accepted"));
    expect(onNeedName).toHaveBeenCalledTimes(2);
  });

  it("asks one question for several attempts made while it is still waiting", async () => {
    let resolve: (answer: boolean) => void = () => undefined;
    const onNeedName = vi.fn(() => new Promise<boolean>((done) => (resolve = done)));
    const onChange = vi.fn();
    documentIn({ role: "edit", onChange, onNeedName });
    type("a");
    type("ab");
    type("abc");
    await waitFor(() => expect(onNeedName).toHaveBeenCalledTimes(1));
    resolve(true);
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onNeedName).toHaveBeenCalledTimes(1);
  });

  it("treats a question that fails as a no", async () => {
    const onChange = vi.fn();
    documentIn({ role: "edit", onChange, onNeedName: async () => Promise.reject(new Error("the dialog broke")) });
    type("x");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("never asks someone who is only reading", async () => {
    const onNeedName = vi.fn(async () => true);
    documentIn({ role: "view", onNeedName });
    type("nope");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onNeedName).not.toHaveBeenCalled();
  });
});

/** An adapter the app would write: it holds the threads, and tells the editor when they change. */
function adapter(initial: ThreadMark[] = []) {
  let threads = initial;
  const listeners = new Set<() => void>();
  const created: Anchor[] = [];
  const opened: string[] = [];
  const comments: CommentsAdapter = {
    threads: () => threads,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    create: (anchor) => void created.push(anchor),
    open: (id) => void opened.push(id),
  };
  return {
    comments,
    created,
    opened,
    listeners,
    set(next: ThreadMark[]) {
      threads = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

const mark = (id: string, extra: Partial<ThreadMark> = {}): ThreadMark => ({ id, anchor: { type: "text-quote", quote: "world", prefix: "Hello ", suffix: "", position: 6 }, resolved: false, outdated: false, ...extra });

describe("comments", () => {
  it("shows how many threads are marked, follows live changes, and leaves outdated ones out", async () => {
    const app = adapter([mark("a")]);
    documentIn({ role: "comment", comments: app.comments });
    expect(screen.getByText("1 comment thread")).toBeTruthy();

    app.set([mark("a"), mark("b"), mark("c", { outdated: true })]);
    await waitFor(() => expect(screen.getByText("2 comment threads")).toBeTruthy());
  });

  it("stops listening when it goes away, and listens only once", () => {
    const app = adapter();
    const { unmount } = documentIn({ role: "comment", comments: app.comments });
    expect(app.listeners.size).toBe(1);
    unmount();
    expect(app.listeners.size).toBe(0);
  });

  it("offers to comment to someone who may, and only once they have selected something", async () => {
    const app = adapter();
    documentIn({ role: "comment", comments: app.comments });
    const button = screen.getByRole("button", { name: "Comment on selection" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    box().setSelectionRange(6, 11);
    fireEvent.select(box());
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(app.created).toHaveLength(1));
    expect(app.created[0]).toEqual({ type: "text-quote", quote: "world", prefix: "Hello ", suffix: "", position: 6 });
  });

  it("offers nothing to someone who is only viewing, or when there is no adapter", () => {
    documentIn({ role: "view", comments: adapter().comments });
    expect(screen.queryByRole("button", { name: "Comment on selection" })).toBeNull();
    cleanup();
    documentIn({ role: "comment" });
    expect(screen.queryByRole("button", { name: "Comment on selection" })).toBeNull();
    expect(screen.queryByText(/comment thread/)).toBeNull();
  });

  it("asks an anonymous person for a name before it starts a thread", async () => {
    const app = adapter();
    let answer = false;
    const onNeedName = vi.fn(async () => answer);
    documentIn({ role: "comment", comments: app.comments, onNeedName });
    box().setSelectionRange(0, 5);
    fireEvent.select(box());

    fireEvent.click(screen.getByRole("button", { name: "Comment on selection" }));
    await waitFor(() => expect(onNeedName).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.created).toHaveLength(0);

    answer = true;
    fireEvent.click(screen.getByRole("button", { name: "Comment on selection" }));
    await waitFor(() => expect(app.created).toHaveLength(1));
  });

  it("does not fall over if the selection is gone by the time the name has been given", async () => {
    const app = adapter();
    documentIn({ role: "comment", comments: app.comments, onNeedName: async () => true });
    box().setSelectionRange(3, 3);
    fireEvent.select(box());
    // A collapsed selection is not one: the button stays off and nothing is created.
    expect((screen.getByRole("button", { name: "Comment on selection" }) as HTMLButtonElement).disabled).toBe(true);
    expect(app.created).toHaveLength(0);
  });
});
