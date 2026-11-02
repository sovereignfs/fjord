"use client";

import { useState } from "react";
import { Alert, Button, FormField, Input } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import { MAX_TITLE_CHARS } from "../../files/limits";
import type { Properties } from "../document";

/**
 * The Document properties panel (ROADMAP 1b.5, DESIGN.md §9): what the header of a note or a document says, beside the editor
 * and not in it. The title can be changed; the identifier and the day it was made are the format's (spec §8) and are only
 * shown; every other key is something Fjord does not know, shown as it is written and kept as it is. When the file has no
 * header yet, the panel says one is added the first time it is edited, which is when `properties` is the one it will get.
 */
export function DocumentProperties({
  properties,
  pending,
  disabled,
  onTitle,
  onDate,
  onTags,
  tagSuggestions = [],
}: {
  properties: Properties;
  /** True while the header is still to be added, on the first edit. */
  pending: boolean;
  disabled: boolean;
  /** Ask for the title to be set; the answer is a message when it could not be. */
  onTitle: (title: string) => Promise<string | null>;
  /** Ask for the `date` to be set, or taken away with null (spec §8.1); the answer is a message when it could not be. The file is not moved. */
  onDate?: (date: string | null) => Promise<string | null>;
  /** Ask for the `tags` to be set as written (spec §8.1); the answer is a message when they could not be. */
  onTags?: (tags: string[]) => Promise<string | null>;
  /** Tags already in use in this repository, as first written, the most used first: offered while one is typed (ROADMAP 3b.3). */
  tagSuggestions?: string[];
}) {
  const [tagText, setTagText] = useState((properties.tags ?? []).join(", "));
  const [tagging, setTagging] = useState(false);
  const [tagProblem, setTagProblem] = useState<string | null>(null);
  const typedTags = tagText.split(",").map((tag) => tag.trim()).filter((tag) => tag !== "");
  const tagsUnchanged = typedTags.join("\n") === (properties.tags ?? []).join("\n");
  // What is being typed now, after the last comma, and the tags in use that begin with it: existing spellings, so `Run` is not added beside `run`.
  const typing = (tagText.split(",").pop() ?? "").trim().toLowerCase();
  const offered = typing === "" ? [] : tagSuggestions.filter((tag) => tag.toLowerCase().startsWith(typing) && !typedTags.includes(tag)).slice(0, 8);
  const [date, setDate] = useState(properties.date ?? "");
  const [dating, setDating] = useState(false);
  const [dateProblem, setDateProblem] = useState<string | null>(null);
  const dateUnchanged = date.trim() === (properties.date ?? "");
  const [title, setTitle] = useState(properties.title ?? "");
  const [changing, setChanging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const unchanged = title.trim() === (properties.title ?? "");

  async function change() {
    setChanging(true);
    setProblem(null);
    const message = await onTitle(title);
    setChanging(false);
    if (message !== null) setProblem(message);
  }

  return (
    <details className={styles.itemMeta} data-testid="document-properties">
      <summary>Properties</summary>
      {pending ? <p>This file has no header yet. One is added, with an identifier, a title and the date, the first time you edit it. Nothing changes until then.</p> : null}
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          void change();
        }}
      >
        <FormField label="Title" hint="Advisory: the file's name is not changed.">
          {(field) => <Input {...field} name="title" autoComplete="off" maxLength={MAX_TITLE_CHARS} value={title} onChange={(e) => setTitle(e.target.value)} disabled={disabled || pending || changing} />}
        </FormField>
        {problem ? (
          <div className={styles.notice}>
            <Alert variant="error" heading="The title was not changed">
              {problem}
            </Alert>
          </div>
        ) : null}
        <div className={styles.actions}>
          <Button type="submit" variant="secondary" size="sm" loading={changing} disabled={disabled || pending || unchanged}>
            Set title
          </Button>
        </div>
      </form>
      {onDate ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void (async () => {
              setDating(true);
              setDateProblem(null);
              const message = await onDate(date.trim() === "" ? null : date.trim());
              setDating(false);
              if (message !== null) setDateProblem(message);
            })();
          }}
        >
          <FormField label="Date" hint="What it is about, as 2026-11-02, or with a time and your offset, 2026-11-02T08:14:00+05:30. The file is not moved.">
            {(field) => <Input {...field} name="date" autoComplete="off" maxLength={64} value={date} onChange={(e) => setDate(e.target.value)} disabled={disabled || pending || dating} />}
          </FormField>
          {dateProblem ? (
            <div className={styles.notice}>
              <Alert variant="error" heading="The date was not changed">
                {dateProblem}
              </Alert>
            </div>
          ) : null}
          <div className={styles.actions}>
            <Button type="submit" variant="secondary" size="sm" loading={dating} disabled={disabled || pending || dateUnchanged}>
              Set date
            </Button>
          </div>
        </form>
      ) : null}
      {onTags ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void (async () => {
              setTagging(true);
              setTagProblem(null);
              const message = await onTags(typedTags);
              setTagging(false);
              if (message !== null) setTagProblem(message);
            })();
          }}
        >
          <FormField label="Tags" hint="Separated by commas. Case does not make a different tag, and / nests one: project/fjord is under project.">
            {(field) => <Input {...field} name="tags" autoComplete="off" value={tagText} onChange={(e) => setTagText(e.target.value)} disabled={disabled || pending || tagging} />}
          </FormField>
          {offered.length > 0 ? (
            <p aria-label="Tags in use" data-testid="tag-suggestions">
              {offered.map((tag) => (
                <Button
                  key={tag}
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const done = tagText.split(",").slice(0, -1).map((t) => t.trim()).filter((t) => t !== "");
                    setTagText([...done, tag].join(", ") + ", ");
                  }}
                >
                  #{tag}
                </Button>
              ))}
            </p>
          ) : null}
          {tagProblem ? (
            <div className={styles.notice}>
              <Alert variant="error" heading="The tags were not changed">
                {tagProblem}
              </Alert>
            </div>
          ) : null}
          <div className={styles.actions}>
            <Button type="submit" variant="secondary" size="sm" loading={tagging} disabled={disabled || pending || tagsUnchanged}>
              Set tags
            </Button>
          </div>
        </form>
      ) : null}
      <dl>
        <dt>Identifier</dt>
        <dd>
          <code>{properties.id ?? "none"}</code>
        </dd>
        <dt>Created</dt>
        <dd>{properties.created ?? "not recorded"}</dd>
        {properties.others.map(({ key, value }) => (
          <div key={key} data-testid="other-property">
            <dt>{key}</dt>
            <dd>
              <code>{value}</code>
            </dd>
          </div>
        ))}
      </dl>
      {properties.others.length > 0 ? <p>Properties Fjord does not know are kept as they are.</p> : null}
    </details>
  );
}
