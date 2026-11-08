'use client';

import { useState } from 'react';
import { Alert, Button, FormField, Input } from '@sovereignfs/ui';
import { SetIcon } from '../../ui/icons';
import styles from '../../auth/screens/screens.module.css';
import own from './DocumentProperties.module.css';
import { MAX_TITLE_CHARS } from '../../files/limits';
import type { Properties } from '../document';
import { FieldsForm } from './FieldsForm';
import { momentText } from '../../ui/dates';

/**
 * The Document properties panel (ROADMAP 1b.5, DESIGN.md §9): what the header of a note or a document says, beside the editor
 * and not in it. The title can be changed; the identifier and the day it was made are the format's (spec §8) and are only
 * shown; every other key is something Fjord does not know, shown as it is written and kept as it is. When the file has no
 * header yet, the panel says one is added the first time it is edited, which is when `properties` is the one it will get.
 *
 * In a drive (`rename` given: the owner's request for the document's screen) the field that was the title is the **file's name**, which is what changing it does (a document's title is what it says
 * in its first heading, or in its header), and the date is not offered; the identifier and the day it was made are shown, and so is when it last changed, from the repository's history (`updated`).
 */
export function DocumentProperties({
  properties,
  pending,
  disabled,
  onTitle,
  onDate,
  onTags,
  onField,
  site = false,
  tagSuggestions = [],
  rename,
  address,
  updated,
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
  /** Ask for one field to be set, to text or a yes or no, or taken away with null (RFC 0002); the answer is a message when it could not be. */
  onField?: (key: string, value: string | boolean | null) => Promise<string | null>;
  /** Whether this is a site's post: `draft` and `description` are offered by name. */
  site?: boolean;
  /** Tags already in use in this repository, as first written, the most used first: offered while one is typed (ROADMAP 3b.3). */
  tagSuggestions?: string[];
  /** For a drive's document: its file's name without the extension, the extension that stays, and the way to change it; the answer is a message when it could not be. */
  /** The file's address by its identifier. */
  address?: string | undefined;
  rename?:
    | { stem: string; suffix: string; onRename: (stem: string) => Promise<string | null> }
    | undefined;
  /** When the file last changed in the repository (ISO 8601), if the host said. */
  updated?: string | null | undefined;
}) {
  const [tagText, setTagText] = useState((properties.tags ?? []).join(', '));
  const [tagging, setTagging] = useState(false);
  const [tagProblem, setTagProblem] = useState<string | null>(null);
  const typedTags = tagText
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
  const tagsUnchanged = typedTags.join('\n') === (properties.tags ?? []).join('\n');
  // What is being typed now, after the last comma, and the tags in use that begin with it: existing spellings, so `Run` is not added beside `run`.
  const typing = (tagText.split(',').pop() ?? '').trim().toLowerCase();
  const offered =
    typing === ''
      ? []
      : tagSuggestions
          .filter((tag) => tag.toLowerCase().startsWith(typing) && !typedTags.includes(tag))
          .slice(0, 8);
  const [date, setDate] = useState(properties.date ?? '');
  const [dating, setDating] = useState(false);
  const [dateProblem, setDateProblem] = useState<string | null>(null);
  const dateUnchanged = date.trim() === (properties.date ?? '');
  const [fileName, setFileName] = useState(rename?.stem ?? '');
  const [renaming, setRenaming] = useState(false);
  const [renameProblem, setRenameProblem] = useState<string | null>(null);
  const [title, setTitle] = useState(properties.title ?? '');
  const [changing, setChanging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const unchanged = title.trim() === (properties.title ?? '');

  async function change() {
    setChanging(true);
    setProblem(null);
    const message = await onTitle(title);
    setChanging(false);
    if (message !== null) setProblem(message);
  }

  return (
    <details className={own.panel} data-testid="document-properties">
      <summary className={own.summary}>
        <SetIcon name="chevron-right" size={16} className={own.chevron} />
        <span>Properties</span>
        <span className={own.hint}>
          {rename ? 'File name, tags and details' : 'Title, tags and details'}
        </span>
      </summary>
      <div className={own.body}>
        {pending ? (
          <p>
            This file has no header, so no identifier. It is edited as it is. One is added, with an
            identifier, a title and the date, only when you share it, and only after you agree.
          </p>
        ) : null}
        {rename ? (
          <form
            className={own.form}
            onSubmit={(event) => {
              event.preventDefault();
              void (async () => {
                setRenaming(true);
                setRenameProblem(null);
                const message = await rename.onRename(fileName.trim());
                setRenaming(false);
                if (message !== null) setRenameProblem(message);
              })();
            }}
          >
            <FormField
              label="File name"
              hint={rename.suffix === '' ? undefined : `It stays ${rename.suffix}.`}
            >
              {(field) => (
                <Input
                  {...field}
                  name="filename"
                  autoComplete="off"
                  maxLength={MAX_TITLE_CHARS}
                  value={fileName}
                  onChange={(e) => setFileName(e.target.value)}
                  disabled={disabled || renaming}
                />
              )}
            </FormField>
            {renameProblem ? (
              <Alert variant="error" heading="The file was not renamed">
                {renameProblem}
              </Alert>
            ) : null}
            <div className={own.actions}>
              <Button
                type="submit"
                variant="secondary"
                size="sm"
                loading={renaming}
                disabled={disabled || fileName.trim() === '' || fileName.trim() === rename.stem}
              >
                Rename
              </Button>
            </div>
          </form>
        ) : (
          <form
            className={own.form}
            onSubmit={(event) => {
              event.preventDefault();
              void change();
            }}
          >
            <FormField label="Title" hint="Advisory: the file's name is not changed.">
              {(field) => (
                <Input
                  {...field}
                  name="title"
                  autoComplete="off"
                  maxLength={MAX_TITLE_CHARS}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  disabled={disabled || pending || changing}
                />
              )}
            </FormField>
            {problem ? (
              <div className={styles.notice}>
                <Alert variant="error" heading="The title was not changed">
                  {problem}
                </Alert>
              </div>
            ) : null}
            <div className={styles.actions}>
              <Button
                type="submit"
                variant="secondary"
                size="sm"
                loading={changing}
                disabled={disabled || pending || unchanged}
              >
                Set title
              </Button>
            </div>
          </form>
        )}
        {onDate && !rename ? (
          <form
            className={own.form}
            onSubmit={(event) => {
              event.preventDefault();
              void (async () => {
                setDating(true);
                setDateProblem(null);
                const message = await onDate(date.trim() === '' ? null : date.trim());
                setDating(false);
                if (message !== null) setDateProblem(message);
              })();
            }}
          >
            <FormField
              label="Date"
              hint="What it is about, as 2026-11-02, or with a time and your offset, 2026-11-02T08:14:00+05:30. The file is not moved."
            >
              {(field) => (
                <Input
                  {...field}
                  name="date"
                  autoComplete="off"
                  maxLength={64}
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  disabled={disabled || pending || dating}
                />
              )}
            </FormField>
            {dateProblem ? (
              <div className={styles.notice}>
                <Alert variant="error" heading="The date was not changed">
                  {dateProblem}
                </Alert>
              </div>
            ) : null}
            <div className={styles.actions}>
              <Button
                type="submit"
                variant="secondary"
                size="sm"
                loading={dating}
                disabled={disabled || pending || dateUnchanged}
              >
                Set date
              </Button>
            </div>
          </form>
        ) : null}
        {onTags ? (
          <form
            className={own.form}
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
            <FormField
              label="Tags"
              hint="Separated by commas. Case does not make a different tag, and / nests one: project/fjord is under project."
            >
              {(field) => (
                <Input
                  {...field}
                  name="tags"
                  autoComplete="off"
                  value={tagText}
                  onChange={(e) => setTagText(e.target.value)}
                  disabled={disabled || pending || tagging}
                />
              )}
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
                      const done = tagText
                        .split(',')
                        .slice(0, -1)
                        .map((t) => t.trim())
                        .filter((t) => t !== '');
                      setTagText([...done, tag].join(', ') + ', ');
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
              <Button
                type="submit"
                variant="secondary"
                size="sm"
                loading={tagging}
                disabled={disabled || pending || tagsUnchanged}
              >
                Set tags
              </Button>
            </div>
          </form>
        ) : null}
        {onField && !pending ? (
          <FieldsForm properties={properties} site={site} disabled={disabled} onField={onField} />
        ) : null}
        <dl className={own.facts}>
          <dt>Identifier</dt>
          <dd>
            <code>{properties.id ?? 'none'}</code>
          </dd>
          {address ? (
            <>
              <dt>Address</dt>
              <dd>
                <a href={address}>{address}</a>{' '}
                <span className={own.note}>It stays the same when the file moves.</span>
              </dd>
            </>
          ) : null}
          <dt>Created</dt>
          <dd>{properties.created ? whenText(properties.created) : 'not recorded'}</dd>
          {updated !== undefined ? (
            <>
              <dt>Last updated</dt>
              <dd data-testid="last-updated">{updated ? whenText(updated) : 'not known'}</dd>
            </>
          ) : null}
          {properties.others
            .filter((other) => !onField || pending || other.editable === undefined)
            .map(({ key, value }) => (
              <div key={key} data-testid="other-property" className={own.fact}>
                <dt>{key}</dt>
                <dd>
                  <code>{value}</code>
                </dd>
              </div>
            ))}
        </dl>
        {properties.others.length > 0 ? (
          <p className={own.note}>Properties Fjord does not know are kept as they are.</p>
        ) : null}
      </div>
    </details>
  );
}

/** A moment as the page says it, the same on the server and in the browser: `4 Nov 2026, 14:02 UTC`; a text that is not a moment is shown as it is written. */
function whenText(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : momentText(parsed);
}
