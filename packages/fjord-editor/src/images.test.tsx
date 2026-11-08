// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { imageMarkdown, pictureFiles } from "./image-markdown.js";
import { NoteEditor } from "./NoteEditor.js";
import { LABEL, viewOf } from "./testing/surfaces.js";
import type { EditorHandle, ImageSource } from "./types.js";

/**
 * Pictures in a text (RFC 0004): the editors ask an `ImageSource` and write `![alt](reference)`, and know nothing of sites. A fake source stands in for
 * the app, so what is held here is the editor's side: where the text goes, that a text which may only be read is never changed, and what a paste does.
 */
afterEach(cleanup);

const source = (over: Partial<ImageSource> = {}): ImageSource => ({
  choose: vi.fn(async () => ({ reference: "../images/a.png", alt: "A red square" })),
  add: vi.fn(async () => ({ reference: "../images/pasted.png", alt: "A screenshot" })),
  ...over,
});
const view = () => viewOf(screen.getByRole("textbox", { name: LABEL }));
const text = () => view().state.sliceDoc();

describe("the Markdown for a picture", () => {
  it("is ![alt](reference)", () => {
    expect(imageMarkdown("../images/a.png", "A red square")).toBe("![A red square](../images/a.png)");
    expect(imageMarkdown("/content/images/a.png", "")).toBe("![](/content/images/a.png)");
  });
  it("cannot be ended early by what the words or the name hold", () => {
    expect(imageMarkdown("a.png", "x](https://evil.example) [y")).toBe("![x\\](https://evil.example) \\[y](a.png)");
    expect(imageMarkdown("a b (1).png", "x")).toBe("![x](<a b (1).png>)");
    expect(imageMarkdown("a.png\n)[x](y", "line\nbreak")).toBe("![line break](<a.png)[x](y>)");
  });
  it("takes the pictures out of what was pasted", () => {
    const png = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
    const doc = new File([new Uint8Array([1])], "a.pdf", { type: "application/pdf" });
    expect(pictureFiles([png, doc])).toEqual([png]);
    expect(pictureFiles(null)).toEqual([]);
  });
});

describe("the note editor", () => {
  it("puts a chosen picture where the caret is, and changes nothing else of the note", async () => {
    const images = source();
    const handle = createRef<EditorHandle>();
    const onChange = vi.fn();
    render(<NoteEditor ref={handle} aria-label={LABEL} value={"first\r\nsecond\r\n"} images={images} onChange={onChange} />);
    view().dispatch({ selection: { anchor: 5 } });
    await act(async () => handle.current?.insertImage?.());
    expect(images.choose).toHaveBeenCalledTimes(1);
    expect(text()).toBe("first![A red square](../images/a.png)\r\nsecond\r\n");
    expect(onChange).toHaveBeenLastCalledWith("first![A red square](../images/a.png)\r\nsecond\r\n");
  });

  it("writes nothing when the person closes the library", async () => {
    const images = source({ choose: async () => null });
    const handle = createRef<EditorHandle>();
    const onChange = vi.fn();
    render(<NoteEditor ref={handle} aria-label={LABEL} value="note" images={images} onChange={onChange} />);
    await act(async () => handle.current?.insertImage?.());
    expect(text()).toBe("note");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("never changes a text that may only be read", async () => {
    const images = source();
    const handle = createRef<EditorHandle>();
    render(<NoteEditor ref={handle} aria-label={LABEL} value="read only" images={images} readOnly />);
    await act(async () => handle.current?.insertImage?.());
    expect(images.choose).not.toHaveBeenCalled();
    expect(text()).toBe("read only");
  });

  it("has no way to insert a picture without a source", async () => {
    const handle = createRef<EditorHandle>();
    render(<NoteEditor ref={handle} aria-label={LABEL} value="note" />);
    await act(async () => handle.current?.insertImage?.());
    expect(text()).toBe("note");
  });

  it("gives a pasted picture to the app and writes what the app answers (what is not a picture is `pictureFiles`', above)", async () => {
    const images = source();
    render(<NoteEditor aria-label={LABEL} value="note" images={images} />);
    const png = new File([new Uint8Array([1])], "shot.png", { type: "image/png" });
    const event = createEvent.paste(view().contentDOM, { clipboardData: { files: [png], getData: () => "" } });
    await act(async () => {
      fireEvent(view().contentDOM, event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(images.add).toHaveBeenCalledWith([png]);
    expect(text()).toContain("![A screenshot](../images/pasted.png)");

  });

  it("does not take a pasted picture into a text that may only be read", () => {
    const images = source();
    render(<NoteEditor aria-label={LABEL} value="note" images={images} readOnly />);
    const png = new File([new Uint8Array([1])], "shot.png", { type: "image/png" });
    fireEvent(view().contentDOM, createEvent.paste(view().contentDOM, { clipboardData: { files: [png], getData: () => "" } }));
    expect(images.add).not.toHaveBeenCalled();
  });

  it("leaves the text as it was when the app gives the picture up", async () => {
    const images = source({ add: vi.fn(async () => null) });
    render(<NoteEditor aria-label={LABEL} value="note" images={images} />);
    const png = new File([new Uint8Array([1])], "shot.png", { type: "image/png" });
    fireEvent(view().contentDOM, createEvent.drop(view().contentDOM, { dataTransfer: { files: [png] } }));
    await waitFor(() => expect(images.add).toHaveBeenCalled());
    expect(text()).toBe("note");
  });
});
