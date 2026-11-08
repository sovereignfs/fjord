// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  ButtonWithTooltip,
  CodeToggle,
  CreateLink,
  InsertImage,
  InsertTable,
  InsertThematicBreak,
  ListsToggle,
  MDXEditor,
  type MDXEditorMethods,
  Separator,
  UndoRedo,
  codeBlockPlugin,
  codeMirrorPlugin,
  headingsPlugin,
  imagePlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
} from "@mdxeditor/editor";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { imageMarkdown, pictureFiles } from "../image-markdown.js";
import type { EditorHandle, ImageChoice, ImageSource } from "../types.js";
import { type Unsafe, differences, keepsLineEndings, sameMeaning, unreadable, withEdgesLike } from "./meaning.js";
import { type RestylePreview, describeRestyle } from "./restyle.js";
import { HOUSE_STYLE, inHouseStyle } from "./style.js";
import { translator } from "./translation.js";

/**
 * The visual core of the document editor (ROADMAP 1b.3): MDXEditor with the Markdown it can write and nothing else, and the
 * promises the package makes about a document held to it.
 *
 *  - **Never a change the person did not make.** The editor rewrites a document in its own style, so what it holds is
 *    compared by meaning with what it was given (`meaning.ts`). On opening a document, and whenever the app sets a different
 *    one, a text whose meaning it cannot keep is reported (`onUnsafe`) and never edited: the document editor then shows the
 *    Markdown instead. A change that is only style is not an edit: nothing is reported for it.
 *  - **`onEdit` is for the person's edits only**, with the whole new text, written in the style below and with the final line
 *    break the document had. The app says whether it took the edit (a person who declined to give their name has not
 *    changed the document); if it did not, the editor goes back to what the app holds.
 *  - **Markdown only**: the toolbar has what Markdown can say. No underline, colour or highlight; no JSX.
 *
 * The style it writes is the house style (`style.ts`, ROADMAP 1b.4). A text that is not in it is restyled when it is edited, which is not an
 * edit the person made, so the editor says what would change as soon as it has read the text (`onRestyle`) and the app decides whether
 * to let it be edited here.
 */
export interface RichDocumentProps {
  /** The Markdown body the app holds. */
  value: string;
  editable: boolean;
  "aria-label"?: string | undefined;
  className?: string | undefined;
  /** The person edited: this is the whole new text. Resolves whether the app took it. */
  onEdit: (text: string) => Promise<boolean>;
  /** The text cannot be held by the visual editor without a change of meaning, and why: for the person to fix. */
  onUnsafe: (why: Unsafe) => void;
  /** What editing this text here would restyle, once the editor has read it; `null` when it would restyle nothing. */
  onRestyle?: ((preview: RestylePreview | null) => void) | undefined;
  /** Where pictures come from (RFC 0004): the toolbar's image button asks it, a picture pasted or dropped is given to it. Without it the button is MDXEditor's URL dialog. */
  images?: ImageSource | undefined;
}

/** The languages a code block can be given in the toolbar-less editor; a block in another language is kept as it is. */
const CODE_LANGUAGES = { "": "Plain text", txt: "Plain text", sh: "Shell", bash: "Shell", js: "JavaScript", ts: "TypeScript", tsx: "TSX", jsx: "JSX", json: "JSON", css: "CSS", html: "HTML", md: "Markdown", py: "Python", rust: "Rust", go: "Go", yaml: "YAML", sql: "SQL" };

const TO_MARKDOWN = HOUSE_STYLE.toMarkdown;

/** The icon of a picture (Lucide's `image`), drawn here so that the package depends on no icon set. */
const PictureIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
  </svg>
);

/** The toolbar. `onLibrary` makes the image button ask the app for a picture; without it the button is MDXEditor's, which takes a URL. */
const toolbar = (onLibrary: (() => void) | undefined) => () => (
  <>
    <UndoRedo />
    <Separator />
    <BoldItalicUnderlineToggles options={["Bold", "Italic"]} />
    <CodeToggle />
    <Separator />
    <BlockTypeSelect />
    <ListsToggle options={["bullet", "number"]} />
    <Separator />
    <CreateLink />
    {onLibrary ? (
      <ButtonWithTooltip title="Insert image from the library" onClick={onLibrary}>
        <PictureIcon />
      </ButtonWithTooltip>
    ) : (
      <InsertImage />
    )}
    <InsertTable />
    <InsertThematicBreak />
  </>
);

export const RichDocument = forwardRef<EditorHandle, RichDocumentProps>(function RichDocument({ value, editable, "aria-label": label, className, onEdit, onUnsafe, onRestyle, images }, ref) {
  const editor = useRef<MDXEditorMethods>(null);
  /** The app's picture source as of now, for what happens later (a button, a paste) without making a new editor for each render. */
  const source = useRef(images);
  source.current = images;
  const hasImages = images !== undefined;
  const canEdit = useRef(editable);
  canEdit.current = editable;
  /** The text the app holds, which is what the editor is to show. */
  const held = useRef(value);
  /** The text the app gave, as it gave it: what an edit and its undo come back to, byte for byte, not in the editor's style. */
  const baseline = useRef(value);
  /** The text last reported as an edit, until the app has answered: the app's `value` becomes it at once, and is not news. */
  const pending = useRef<string | null>(null);
  /** Bumped to start the editor again from the text the app holds. */
  const [revision, setRevision] = useState(0);
  /** The element popups open in, so that they are inside what the stylesheet styles. */
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        // Lexical puts the caret in the text, which is what makes a browser focus it; focusing the surface itself as well is
        // what makes every browser do so, and a screen reader follow.
        editor.current?.focus();
        container?.querySelector<HTMLElement>('[role="textbox"]')?.focus();
      },
      async insertImage() {
        await fromLibrary();
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `fromLibrary` reads refs only
    [container],
  );

  /** Put a picture the app gave where the caret is. The person's edit: MDXEditor reports it as one, and it is held to the same checks. */
  function put(choice: ImageChoice | null) {
    if (!choice || !canEdit.current) return;
    editor.current?.focus();
    editor.current?.insertMarkdown(imageMarkdown(choice.reference, choice.alt));
  }
  async function fromLibrary() {
    const from = source.current;
    if (from && canEdit.current) put(await from.choose());
  }
  /** A picture pasted or dropped goes to the app, which adds it and asks for its words; the editor does not also take it in as MDXEditor would. */
  function pictures(event: { clipboardData?: DataTransfer | null; dataTransfer?: DataTransfer | null; preventDefault(): void; stopPropagation(): void }) {
    const from = source.current;
    if (!from || !canEdit.current) return;
    const files = pictureFiles((event.clipboardData ?? event.dataTransfer)?.files);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    void from.add(files).then(put);
  }


  // Opening a document: one whose line breaks the editor would rewrite is not for it, whatever else it holds.
  useEffect(() => {
    if (!keepsLineEndings(value)) onUnsafe({ reason: "line-endings" });
  }, [value, onUnsafe]);

  // The app sets a different text (a conflict settled, a draft discarded): the editor starts again from it, which is also how
  // it is checked, below. It is not set into the editor that is there, because the editor does not say when it has taken it.
  useEffect(() => {
    if (value === held.current || value === pending.current) return;
    held.current = value;
    baseline.current = value;
    setRevision((count) => count + 1);
  }, [value]);

  const plugins = useMemo(
    () => [
      headingsPlugin({ allowedHeadingLevels: [1, 2, 3, 4, 5, 6] }),
      listsPlugin(),
      quotePlugin(),
      thematicBreakPlugin(),
      tablePlugin(HOUSE_STYLE.table),
      linkPlugin(),
      linkDialogPlugin(),
      imagePlugin(hasImages ? { imagePreviewHandler: (reference: string) => source.current?.resolve?.(reference) ?? Promise.resolve(reference) } : undefined),
      codeBlockPlugin({ defaultCodeBlockLanguage: "" }),
      codeMirrorPlugin({ codeBlockLanguages: CODE_LANGUAGES }),
      markdownShortcutPlugin(),
      toolbarPlugin({ toolbarContents: toolbar(hasImages ? () => void fromLibrary() : undefined) }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the handlers read refs, so only whether there is a source makes new plugins
    [hasImages],
  );

  return (
    <div className={["fe-rich", className].filter(Boolean).join(" ")} ref={setContainer} onPasteCapture={pictures} onDropCapture={pictures}>
      <MDXEditor
        key={revision}
        ref={editor}
        markdown={held.current}
        trim={false}
        suppressHtmlProcessing
        readOnly={!editable}
        plugins={plugins}
        toMarkdownOptions={TO_MARKDOWN}
        overlayContainer={container}
        className="fe-mdx"
        contentEditableClassName="fe-rich-content"
        translation={translator(label)}
        onError={(payload) => onUnsafe(unreadable(held.current, typeof payload?.error === "string" ? payload.error : ""))}
        onChange={(markdown, initialNormalize) => {
          // The editor says, once it has read what it was given, what it would write back if that were saved. That is not an
          // edit. It is the check: the text it would write must mean what the text it read does, or it is not for this editor.
          // (Nothing is said when it would write the same text, which is nothing to check. Until it has said, it has not read:
          // asking it for its text at the moment it is made gives back the text it was made with.)
          if (initialNormalize) {
            const restyled = withEdgesLike(held.current, inHouseStyle(markdown));
            if (!sameMeaning(held.current, restyled)) onUnsafe({ reason: "meaning", differences: differences(held.current, restyled) });
            else onRestyle?.(restyled === held.current ? null : describeRestyle(held.current, restyled));
            return;
          }
          if (!editable) return;
          const written = withEdgesLike(held.current, inHouseStyle(markdown));
          // An edit undone is no edit: the text the app gave comes back as it was written, not as the editor would write it.
          const next = sameMeaning(written, baseline.current) ? baseline.current : written;
          // A change of style alone is not a change. What it is compared with is the latest text the app has been told, which
          // is not yet the one it holds while an earlier edit waits for a name: an edit and its undo are two edits, and the
          // app must come out holding the second.
          if (sameMeaning(next, pending.current ?? held.current)) return;
          pending.current = next;
          void onEdit(next).then((taken) => {
            if (pending.current === next) pending.current = null;
            if (taken) held.current = next;
            else setRevision((count) => count + 1); // not taken: the document is as the app holds it
          });
        }}
      />
    </div>
  );
});
