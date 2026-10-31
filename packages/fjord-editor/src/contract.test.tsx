// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type RenderResult, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { cloneElement, createRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentEditor } from "./DocumentEditor.js";
import { RichDocument } from "./rich/RichDocument.js";
import { NoteEditor } from "./NoteEditor.js";
import { LABEL, type Surface, codeMirror, visual } from "./testing/surfaces.js";
import type { Anchor, AnchorReport, CommentsAdapter, DocumentEditorProps, EditorHandle, NoteEditorProps, ThreadMark } from "./types.js";

/**
 * What an editor in this package does, whatever is behind it. These are the tests that CodeMirror (ROADMAP 1b.2) and
 * MDXEditor (1b.3) must all pass: a change of core is a change of what is inside, and these say what must not change.
 * The document editor is run twice: as the visual editor, and as the Markdown it falls back to for a text the visual
 * editor cannot keep as it means (`rich/meaning.ts`), which must behave the same to the app.
 */
afterEach(cleanup);

/** The visual editor is loaded when it is first needed: a test waits for the editing surface before it touches it. */
const ready = () => screen.findByRole("textbox", { name: LABEL });

/**
 * A text the visual editor cannot hold: a block of raw HTML, which it has no way to show or to write back exactly. It is
 * how the document editor comes to be showing Markdown.
 */
const UNHOLDABLE = "Hello world\n\n<div>raw html</div>\n";

/** The document editor has shown Markdown: it decides a moment after the visual editor has read the text. */
const readyAsMarkdown = async () => {
  await waitFor(() => expect(document.querySelector('[data-mode="markdown"]')).not.toBeNull(), { timeout: 8000 });
  return screen.findByRole("textbox", { name: LABEL });
};

/** The app side of a controlled editor: it keeps the text, as the page will. */
function Harness({ initial = "Hello world", render: editor }: { initial?: string; render: (value: string, set: (value: string) => void) => React.ReactNode }) {
  const [value, setValue] = useState(initial);
  return <>{editor(value, setValue)}</>;
}

const documentIn = (props: Partial<DocumentEditorProps> & { role: DocumentEditorProps["role"] }, initial?: string) =>
  render(<Harness {...(initial !== undefined ? { initial } : {})} render={(value, set) => <DocumentEditor aria-label={LABEL} {...props} value={value} onChange={(next) => (props.onChange?.(next), set(next))} />} />);

const noteIn = (props: Partial<NoteEditorProps> = {}, initial?: string) =>
  render(<Harness {...(initial !== undefined ? { initial } : {})} render={(value, set) => <NoteEditor aria-label={LABEL} {...props} value={value} onChange={(next) => (props.onChange?.(next), set(next))} />} />);

interface Case {
  name: string;
  surface: Surface;
  /** Resolves when the editor is what it will stay as, and ready to be touched. */
  ready: () => Promise<HTMLElement>;
  /** What it starts with, as the surface shows it. */
  initial: string;
  edited: string;
  editable: (onChange: (text: string) => void) => RenderResult;
  readOnly: (onChange: (text: string) => void) => RenderResult;
  /** The editor, with a text of the app's choosing. */
  make: (value: string, props?: { onChange?: (text: string) => void }) => React.ReactElement;
}

const editors: Case[] = [
  {
    name: "DocumentEditor (visual)",
    surface: visual,
    ready,
    initial: "Hello world",
    edited: "Hello brave new world",
    editable: (onChange) => documentIn({ role: "edit", onChange }),
    readOnly: (onChange) => documentIn({ role: "view", onChange }),
    make: (value, props) => <DocumentEditor aria-label={LABEL} role="edit" value={value} {...(props?.onChange ? { onChange: props.onChange } : {})} />,
  },
  {
    name: "DocumentEditor (as Markdown)",
    surface: codeMirror,
    ready: readyAsMarkdown,
    initial: UNHOLDABLE,
    edited: `${UNHOLDABLE}more\n`,
    editable: (onChange) => documentIn({ role: "edit", onChange }, UNHOLDABLE),
    readOnly: (onChange) => documentIn({ role: "view", onChange }, UNHOLDABLE),
    make: (value, props) => <DocumentEditor aria-label={LABEL} role="edit" value={value} {...(props?.onChange ? { onChange: props.onChange } : {})} />,
  },
  {
    name: "NoteEditor",
    surface: codeMirror,
    ready,
    initial: "Hello world",
    edited: "Hello brave new world",
    editable: (onChange) => noteIn({ onChange }),
    readOnly: (onChange) => noteIn({ readOnly: true, onChange }),
    make: (value, props) => <NoteEditor aria-label={LABEL} value={value} {...(props?.onChange ? { onChange: props.onChange } : {})} />,
  },
];

describe.each(editors)("$name", ({ surface, initial, edited, editable, readOnly, make, ready }) => {
  it("shows the text it is given, under the name it is given", async () => {
    editable(() => undefined);
    await ready();
    expect(surface.text()).toBe(initial.endsWith("\n") && surface === visual ? initial.trimEnd() : initial);
  });

  it("tells the app the whole new text after the person edits, and shows what the app then holds", async () => {
    const onChange = vi.fn();
    editable(onChange);
    await ready();
    surface.edit(edited);
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith(surface === visual ? `${edited}\n`.replace(/\n+$/, "") : edited);
    await waitFor(() => expect(surface.text()).toBe(edited.replace(/\n+$/, surface === visual ? "" : "\n")));
  });

  it("does not call onChange for a change the app made by setting the text", async () => {
    const onChange = vi.fn();
    const view = render(make(initial, { onChange }));
    await ready();
    view.rerender(make(edited, { onChange }));
    await waitFor(() => expect(surface.text()).toBe(edited));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not change, or say it changed, when it may only be read", async () => {
    const onChange = vi.fn();
    readOnly(onChange);
    await ready();
    expect(surface.readOnly()).toBe(true);
    const before = surface.text();
    surface.edit("Something else");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onChange).not.toHaveBeenCalled();
    expect(surface.text()).toBe(before);
  });

  it("says it can be changed when it can", async () => {
    editable(() => undefined);
    await ready();
    expect(surface.readOnly()).toBe(false);
  });

  it("can be told to take focus", async () => {
    const ref = createRef<EditorHandle>();
    render(cloneElement(make(initial) as React.ReactElement<{ ref?: unknown }>, { ref }));
    await ready();
    // A browser focuses the editing surface; happy-dom does not move focus to an element that has no tab index, so what is
    // checked is that the surface was asked to.
    const asked: unknown[] = [];
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (this: HTMLElement, ...args: Parameters<HTMLElement["focus"]>) {
      asked.push(this);
      return focus.apply(this, args);
    };
    try {
      ref.current?.focus();
      await waitFor(() => expect(asked.includes(surface.element()) || document.activeElement === surface.element()).toBe(true));
    } finally {
      HTMLElement.prototype.focus = focus;
    }
  });
});

const documents = editors.filter((entry) => entry.name.startsWith("DocumentEditor"));

describe.each(documents)("a document editor's role ($name)", ({ surface, initial, ready }) => {
  it("lets `comment` read and select but not change the text", async () => {
    const onChange = vi.fn();
    documentIn({ role: "comment", onChange }, initial);
    await ready();
    expect(surface.readOnly()).toBe(true);
    const before = surface.text();
    surface.edit("changed");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onChange).not.toHaveBeenCalled();
    expect(surface.text()).toBe(before);
  });

  it("lets `edit` change it", async () => {
    documentIn({ role: "edit" }, initial);
    await ready();
    expect(surface.readOnly()).toBe(false);
  });
});

describe.each(documents)("asking an anonymous person for a name (onNeedName) ($name)", ({ surface, initial, edited, ready }) => {
  /** What the app is told: the visual editor writes a document with its final line break, as the app's files have. */
  const told = (text: string) => (surface === visual ? text : text);

  it("asks before their first edit, and the edit goes through once they have given one", async () => {
    const onNeedName = vi.fn(async () => true);
    const onChange = vi.fn();
    documentIn({ role: "edit", onChange, onNeedName }, initial);
    await ready();
    expect(onNeedName).not.toHaveBeenCalled();

    surface.edit(edited);
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onNeedName).toHaveBeenCalledTimes(1);

    // Having a name, they are not asked again.
    surface.edit(told(`${edited} again`));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    expect(onNeedName).toHaveBeenCalledTimes(1);
  });

  it("makes no change when they decline, puts the document back as it was, and asks again at their next attempt", async () => {
    let answer = false;
    const onNeedName = vi.fn(async () => answer);
    const onChange = vi.fn();
    documentIn({ role: "edit", onChange, onNeedName }, initial);
    await ready();
    const before = surface.text();

    surface.edit(edited);
    await waitFor(() => expect(onNeedName).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(surface.text()).toBe(before));

    answer = true;
    surface.edit(edited);
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onNeedName).toHaveBeenCalledTimes(2);
  });

  it("asks one question for several attempts made while it is still waiting", async () => {
    let resolve: (answer: boolean) => void = () => undefined;
    const onNeedName = vi.fn(() => new Promise<boolean>((done) => (resolve = done)));
    const onChange = vi.fn();
    documentIn({ role: "edit", onChange, onNeedName }, initial);
    await ready();
    surface.edit(`${edited} a`);
    surface.edit(`${edited} ab`);
    surface.edit(`${edited} abc`);
    await waitFor(() => expect(onNeedName).toHaveBeenCalledTimes(1));
    resolve(true);
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onNeedName).toHaveBeenCalledTimes(1);
  });

  it("treats a question that fails as a no", async () => {
    const onChange = vi.fn();
    documentIn({ role: "edit", onChange, onNeedName: async () => Promise.reject(new Error("the dialog broke")) }, initial);
    await ready();
    surface.edit(edited);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("never asks someone who is only reading", async () => {
    const onNeedName = vi.fn(async () => true);
    documentIn({ role: "view", onNeedName }, initial);
    await ready();
    surface.edit(edited);
    await new Promise((resolve) => setTimeout(resolve, 30));
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
    await ready();
    expect(screen.getByText("1 comment thread")).toBeTruthy();

    app.set([mark("a"), mark("b"), mark("c", { outdated: true })]);
    await waitFor(() => expect(screen.getByText("2 comment threads")).toBeTruthy());
  });

  it("stops listening when it goes away, and listens only once", async () => {
    const app = adapter();
    const { unmount } = documentIn({ role: "comment", comments: app.comments });
    await ready();
    expect(app.listeners.size).toBe(1);
    unmount();
    expect(app.listeners.size).toBe(0);
  });

  it("offers to comment to someone who may, and only once they have selected something that can be anchored", async () => {
    const app = adapter();
    documentIn({ role: "comment", comments: app.comments });
    await ready();
    const button = screen.getByRole("button", { name: "Comment on selection" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    visual.select(6, 11);
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(app.created).toHaveLength(1));
    expect(app.created[0]).toEqual({ type: "text-quote", quote: "world", prefix: "Hello ", suffix: "", position: 6 });
  });

  describe("marks in the text", () => {
    const painted = new Map<string, string[]>();
    beforeEach(() => {
      painted.clear();
      // The test environment has its own `CSS` (with only a getter), so the browser's highlight API is put in its place and taken out after.
      Object.defineProperty(globalThis, "CSS", { configurable: true, value: { highlights: { set: (name: string, highlight: Range[]) => painted.set(name, highlight.map(String)), delete: (name: string) => painted.delete(name) } } });
      Object.defineProperty(globalThis, "Highlight", {
        configurable: true,
        value: class extends Array<Range> {
          constructor(...ranges: Range[]) {
            super();
            this.push(...ranges);
          }
        },
      });
    });
    afterEach(() => {
      delete (globalThis as Record<string, unknown>).CSS;
      delete (globalThis as Record<string, unknown>).Highlight;
    });

    it("draws a thread over its text, in a document that is only read as well as one that is edited", async () => {
      for (const role of ["view", "comment", "edit"] as const) {
        const app = adapter([mark("a")]);
        const { unmount } = documentIn({ role, comments: app.comments });
        await ready();
        await waitFor(() => expect(painted.get("fe-thread")).toEqual(["world"]), { timeout: 4000 });
        unmount();
        expect(painted.size).toBe(0);
      }
    });

    it("draws a resolved thread apart, follows the threads as they change, and draws none for a thread that is outdated", async () => {
      const app = adapter([mark("a")]);
      documentIn({ role: "comment", comments: app.comments });
      await ready();
      await waitFor(() => expect(painted.get("fe-thread")).toEqual(["world"]));
      app.set([mark("a", { resolved: true }), mark("b", { outdated: true })]);
      await waitFor(() => expect(painted.get("fe-thread-resolved")).toEqual(["world"]));
      expect(painted.has("fe-thread")).toBe(false);
      app.set([]);
      await waitFor(() => expect(painted.size).toBe(0));
    });

    it("marks more strongly the thread the app is showing", async () => {
      const app = adapter([mark("a")]);
      documentIn({ role: "comment", comments: { ...app.comments, active: () => "a" } });
      await ready();
      await waitFor(() => expect(painted.get("fe-thread-active")).toEqual(["world"]));
    });

    it("tells the app what became of each thread in the text, and the anchor to keep for one whose text was edited (ROADMAP 1d.2)", async () => {
      const reports: AnchorReport[] = [];
      const app = adapter([mark("kept"), mark("edited", { anchor: { type: "text-quote", quote: "the rest of this sentence reads as it did", prefix: "", suffix: "", position: 0 } }), mark("gone", { anchor: { type: "text-quote", quote: "zzzz qqqq xxxx wwww vvvv", prefix: "", suffix: "", position: 0 } })]);
      documentIn({ role: "view", comments: { ...app.comments, anchored: (report) => void reports.push(report) } }, "Hello world, and the rest of this sentence reads as before.\n");
      await ready();
      await waitFor(() => expect(reports.length).toBeGreaterThan(0));
      const last = reports[reports.length - 1]!;
      expect(Object.fromEntries(last.fates)).toEqual({ kept: "intact", edited: "edited", gone: "outdated" });
      expect(last.reanchored).toHaveLength(1);
      expect(last.reanchored[0]).toMatchObject({ id: "edited", to: { quote: "the rest of this sentence reads as before", position: 17 } });
      expect(painted.get("fe-thread")).toEqual(["world", "the rest of this sentence reads as before"]);
    });

    it("tells the app which thread a click was on, and nothing for a click elsewhere", async () => {
      const app = adapter([mark("a")]);
      documentIn({ role: "view", comments: app.comments });
      const surface = await ready();
      await waitFor(() => expect(painted.get("fe-thread")).toEqual(["world"]));
      const text = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT).nextNode()!;
      const at = (offset: number) => ((document as unknown as { caretPositionFromPoint: unknown }).caretPositionFromPoint = () => ({ offsetNode: text, offset }));
      document.getSelection()?.removeAllRanges(); // an earlier test's selection is not a drag across this text
      at(8);
      fireEvent.click(surface);
      expect(app.opened).toEqual(["a"]);
      at(2);
      fireEvent.click(surface);
      expect(app.opened).toEqual(["a"]);
      // A click that ends a drag across text is a selection, not a choice of a mark.
      at(8);
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 5);
      document.getSelection()?.addRange(range);
      fireEvent.click(surface);
      expect(app.opened).toEqual(["a"]);
      document.getSelection()?.removeAllRanges();
      delete (document as unknown as { caretPositionFromPoint?: unknown }).caretPositionFromPoint;
    });
  });

  it("offers nothing to someone who is only viewing, or when there is no adapter", async () => {
    documentIn({ role: "view", comments: adapter().comments });
    await ready();
    expect(screen.queryByRole("button", { name: "Comment on selection" })).toBeNull();
    cleanup();
    documentIn({ role: "comment" });
    await ready();
    expect(screen.queryByRole("button", { name: "Comment on selection" })).toBeNull();
    expect(screen.queryByText(/comment thread/)).toBeNull();
  });

  it("asks an anonymous person for a name before it starts a thread", async () => {
    const app = adapter();
    let answer = false;
    const onNeedName = vi.fn(async () => answer);
    documentIn({ role: "comment", comments: app.comments, onNeedName });
    await ready();
    visual.select(0, 5);
    const button = screen.getByRole("button", { name: "Comment on selection" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));

    fireEvent.click(button);
    await waitFor(() => expect(onNeedName).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(app.created).toHaveLength(0);

    answer = true;
    fireEvent.click(button);
    await waitFor(() => expect(app.created).toHaveLength(1));
  });

  it("does nothing for a selection that is empty or that is not in the Markdown as it was read", async () => {
    const app = adapter();
    documentIn({ role: "comment", comments: app.comments, onNeedName: async () => true }, "a **bold** word");
    await ready();
    const button = screen.getByRole("button", { name: "Comment on selection" }) as HTMLButtonElement;
    visual.select(1, 1); // collapsed
    expect(button.disabled).toBe(true);
    visual.select(0, 11); // "a bold word": the Markdown has asterisks in it
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(button.disabled).toBe(true);
    expect(app.created).toHaveLength(0);
  });
});

// The page gives its editor the text it started with and keeps the rest itself: the editor is not to take back what was typed.
describe("an app that gives the text the document started with, always", () => {
  it("does not have what the person typed taken back, in the visual editor or as Markdown", async () => {
    for (const [initial, edited, surface] of [["Hello world", "Hello brave new world", visual], [UNHOLDABLE, `${UNHOLDABLE}more\n`, codeMirror]] as const) {
      const onChange = vi.fn();
      const view = render(<DocumentEditor aria-label={LABEL} role="edit" value={initial} onChange={onChange} />);
      if (surface === visual) await ready();
      else await readyAsMarkdown();
      surface.edit(edited);
      await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
      // The app re-renders, as it does for anything, still giving the text it started with.
      view.rerender(<DocumentEditor aria-label={LABEL} role="edit" value={initial} onChange={onChange} />);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(surface.text()).toBe(edited.replace(/\n+$/, surface === visual ? "" : "\n"));
      cleanup();
    }
  });
});

describe("the visual editor, inside", () => {
  it("is not started again by an edit the app took, as it would be by a text it was set to", async () => {
    documentIn({ role: "edit" });
    const element = await ready();
    visual.edit("Hello brave new world");
    await waitFor(() => expect(visual.text()).toBe("Hello brave new world"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(visual.element()).toBe(element); // the same editing surface: the person's caret and undo history are in it
  });

  it("says nothing for an update made in code while it can only be read", async () => {
    const onChange = vi.fn();
    documentIn({ role: "view", onChange });
    const element = await ready();
    (element as unknown as { __lexicalEditor: { update: (fn: () => void) => void } }).__lexicalEditor.update(() => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode("changed in code"));
      root.append(paragraph);
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("tells the app an edit and its undo as two edits, so that the app holds the second, though the first waited for a name", async () => {
    let answer: (taken: boolean) => void = () => undefined;
    const onNeedName = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const onChange = vi.fn();
    documentIn({ role: "edit", onChange, onNeedName });
    await ready();
    visual.edit("Hello world!");
    await waitFor(() => expect(onNeedName).toHaveBeenCalled());
    visual.edit("Hello world");
    answer(true);
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    expect(onChange.mock.calls.map((call) => call[0])).toEqual(["Hello world!", "Hello world"]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(visual.text()).toBe("Hello world");
  });

  it("gives back the text it was given, byte for byte, when an edit is undone, though it writes in a style of its own", async () => {
    const original = "* star\n* list\n";
    const told: string[] = [];
    documentIn({ role: "edit", onChange: (text) => told.push(text) }, original);
    const element = await ready();
    const editor = (element as unknown as { __lexicalEditor: { update: (fn: () => void) => void } }).__lexicalEditor;
    const set = (to: string) =>
      editor.update(() => {
        const node = $getRoot().getAllTextNodes().find((candidate) => candidate.getTextContent().startsWith("star"));
        node?.setTextContent(to);
      });
    set("starx");
    await waitFor(() => expect(told).toHaveLength(1));
    expect(told[0]).toBe("- starx\n- list\n"); // its own style, for a text that changed
    set("star");
    await waitFor(() => expect(told).toHaveLength(2));
    expect(told[1]).toBe(original); // and the original's, for the text that is the original again
  });

  it("says it cannot hold a text it cannot hold", async () => {
    const onUnsafe = vi.fn();
    render(<RichDocument value={UNHOLDABLE} editable aria-label={LABEL} onEdit={async () => true} onUnsafe={onUnsafe} />);
    await waitFor(() => expect(onUnsafe).toHaveBeenCalled());
  });

  it("is not started again when the app changes the value before it has said whether it took the edit", async () => {
    // An app may set its text as it is told, and answer a moment later: the text it set is the edit, not another text.
    function App() {
      const [text, setText] = useState("Hello world");
      return (
        <RichDocument
          value={text}
          editable
          aria-label={LABEL}
          onUnsafe={() => undefined}
          onEdit={(next) => {
            setText(next);
            return new Promise((resolve) => setTimeout(() => resolve(true), 40));
          }}
        />
      );
    }
    render(<App />);
    const element = await ready();
    visual.edit("Hello brave new world");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(visual.text()).toBe("Hello brave new world");
    expect(visual.element()).toBe(element);
  });

  it("goes back, when an edit is undone, to the text the app last gave it", async () => {
    const told: string[] = [];
    const view = render(<DocumentEditor aria-label={LABEL} role="edit" value="plain" onChange={(text) => told.push(text)} />);
    await ready();
    view.rerender(<DocumentEditor aria-label={LABEL} role="edit" value={"* star\n* list\n"} onChange={(text) => told.push(text)} />);
    const element = await waitFor(() => {
      const found = screen.getByRole("textbox", { name: LABEL });
      expect(found.textContent).toContain("star");
      return found;
    });
    const editor = (element as unknown as { __lexicalEditor: { update: (fn: () => void) => void } }).__lexicalEditor;
    const set = (to: string) => editor.update(() => void $getRoot().getAllTextNodes().find((node) => node.getTextContent().startsWith("star"))?.setTextContent(to));
    set("starx");
    await waitFor(() => expect(told).toHaveLength(1));
    set("star");
    await waitFor(() => expect(told).toHaveLength(2));
    expect(told[1]).toBe("* star\n* list\n");
  });
});

describe("a document the visual editor cannot hold", () => {
  it("is shown as Markdown with a notice, exactly as it was written, and the visual editor is not offered", async () => {
    documentIn({ role: "edit" }, UNHOLDABLE);
    await readyAsMarkdown();
    expect(screen.getByRole("note").textContent).toMatch(/shown as Markdown/);
    expect(codeMirror.text()).toBe(UNHOLDABLE);
    expect(screen.queryByRole("toolbar", { name: /format|toolbar/i })).toBeNull();
  });

  it("is shown in the visual editor, without a notice, when its meaning survives it", async () => {
    documentIn({ role: "edit" }, "# Title\n\n- a\n- b\n\nSome *emphasis* and a [link](https://example.com).\n");
    await ready();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole("note")).toBeNull();
    expect(document.querySelector('[data-mode="visual"]')).not.toBeNull();
  });

  it("is shown as Markdown when the app sets a text the visual editor cannot hold, and as visual when it sets one it can", async () => {
    const view = render(<DocumentEditor aria-label={LABEL} role="edit" value="plain" />);
    await ready();
    expect(document.querySelector('[data-mode="visual"]')).not.toBeNull();
    view.rerender(<DocumentEditor aria-label={LABEL} role="edit" value={UNHOLDABLE} />);
    await readyAsMarkdown();
    expect(codeMirror.text()).toBe(UNHOLDABLE);
  });
});
