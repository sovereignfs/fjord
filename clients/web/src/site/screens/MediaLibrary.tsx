'use client';

import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, FormField, Icon, Input } from '../../ui';
import { useConfirm } from '../../ui/useConfirm';
import { canInsert } from '../alt';
import type { ImageEntry } from '../images';
import { fetchImageUses, fetchImages, imageUrl, removeImage, sendImages } from '../images-client';
import { MAX_SIDE, prepareImage } from '../prepare-image';
import styles from './MediaLibrary.module.css';

/** What choosing a picture gives the editor: where it is, and the words for it. An empty `alt` is a picture that is there for looks, said on purpose. */
export interface ChosenImage {
  path: string;
  name: string;
  alt: string;
}

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/avif';

const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * A site's media library (RFC 0004, ROADMAP 3j): its pictures as tiles, newest work first by name, a filter, upload by a button or by dropping, and
 * in `manage` mode delete (asking first, and naming the posts that show the picture). In `choose` mode a picture is picked and given its alt text before
 * it is handed on: *Insert* stays off until there is some, or the picture is marked as there for looks.
 *
 * Files may be given at the start (`initialFiles`, a picture pasted or dropped into an editor): they go up first and the result is selected.
 */
export function MediaLibrary({
  connectionId,
  mode,
  onChoose,
  initialFiles,
}: {
  connectionId: number;
  mode: 'manage' | 'choose';
  onChoose?: (chosen: ChosenImage) => void;
  initialFiles?: File[];
}) {
  const [images, setImages] = useState<ImageEntry[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [keepOriginal, setKeepOriginal] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [alt, setAlt] = useState('');
  const [decorative, setDecorative] = useState(false);
  const [pixels, setPixels] = useState<Record<string, string>>({});
  const [ask, asking] = useConfirm();
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const listed = await fetchImages(connectionId);
    if (listed.ok) {
      setImages(listed.images);
      setProblem(null);
    } else {
      setProblem(listed.message);
      setImages((current) => current ?? []);
    }
  }, [connectionId]);

  const upload = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setBusy(true);
      setProblem(null);
      const prepared = await Promise.all(files.map((file) => prepareImage(file, { keepOriginal })));
      const made = await sendImages(
        connectionId,
        prepared.map((one) => one.file),
      );
      if (!made.ok) {
        setProblem(made.message);
        setBusy(false);
        return;
      }
      const notes: string[] = [];
      const resized = prepared.filter((one) => one.resized).length;
      if (resized > 0)
        notes.push(
          `${resized === 1 ? 'One image was' : `${resized} images were`} scaled down to ${MAX_SIDE} pixels on the longer side, which also removes where a photo was taken. Tick “Keep the original” to add one as it is.`,
        );
      const there = made.images.filter((one) => one.status === 'exists');
      if (there.length > 0)
        notes.push(
          `${there.map((one) => one.name).join(', ')} ${there.length === 1 ? 'was' : 'were'} already in the library, so it was not added again.`,
        );
      setNotice(notes);
      await load();
      const first = made.images[0];
      if (mode === 'choose' && first) {
        setSelected(first.path);
        setAlt('');
        setDecorative(false);
      }
      setBusy(false);
    },
    [connectionId, keepOriginal, load, mode],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // A picture pasted or dropped into an editor goes up as soon as the library is open.
  const started = useRef(false);
  useEffect(() => {
    if (initialFiles && initialFiles.length > 0 && !started.current) {
      started.current = true;
      void upload(initialFiles);
    }
  }, [initialFiles, upload]);

  const shown = useMemo(
    () =>
      (images ?? []).filter((image) =>
        image.name.toLowerCase().includes(filter.trim().toLowerCase()),
      ),
    [images, filter],
  );
  const chosen = images?.find((image) => image.path === selected);

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDropping(false);
    void upload(Array.from(event.dataTransfer.files));
  }

  async function onRemove(image: ImageEntry) {
    const uses = await fetchImageUses(connectionId, image.path);
    const names = uses.ok ? uses.posts.map((post) => post.slice(post.lastIndexOf('/') + 1)) : [];
    const warning = !uses.ok
      ? 'Which posts show it could not be checked.'
      : names.length > 0
        ? `${names.length === 1 ? 'A post shows' : `${names.length} posts show`} it: ${names.join(', ')}. They will have a broken picture.`
        : uses.complete
          ? 'No post shows it.'
          : 'Not every post could be checked, so one may show it.';
    if (!(await ask({ message: `Delete ${image.name}? ${warning}`, confirm: 'Delete it' }))) return;
    const gone = await removeImage(connectionId, image.path, image.blob);
    if (!gone.ok) {
      setProblem(gone.message);
      return;
    }
    if (selected === image.path) setSelected(null);
    await load();
  }

  const mayInsert = canInsert(chosen !== undefined, alt, decorative);

  return (
    <div className={styles.body}>
      <h2 className={styles.heading}>{mode === 'choose' ? 'Choose an image' : 'Media library'}</h2>
      <div className={styles.bar}>
        <Button type="button" onClick={() => input.current?.click()} loading={busy}>
          <Icon name="upload" aria-hidden /> Add images
        </Button>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          data-testid="media-upload"
          onChange={(event) => {
            void upload(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        <label>
          <input
            type="checkbox"
            checked={keepOriginal}
            onChange={(event) => setKeepOriginal(event.target.checked)}
          />{' '}
          Keep the original
        </label>
        <div className={styles.filter}>
          <FormField label="Find by name" hint="">
            {(field) => (
              <Input
                {...field}
                name="filter"
                autoComplete="off"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            )}
          </FormField>
        </div>
      </div>
      <div
        className={`${styles.drop} ${dropping ? styles.dropping : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={onDrop}
      >
        Drop PNG, JPEG, WebP, GIF or AVIF pictures here, up to 10 MB each. Large photos are scaled
        down first.
      </div>
      {problem ? (
        <Alert variant="error" heading="That did not work">
          {problem}
        </Alert>
      ) : null}
      {notice.map((line) => (
        <Alert key={line} variant="info">
          {line}
        </Alert>
      ))}
      {images === null ? (
        <p className={styles.status}>Loading…</p>
      ) : shown.length === 0 ? (
        <p className={styles.status}>
          {images.length === 0
            ? 'No images yet. Add some, and they can go into any post.'
            : 'No image has that name.'}
        </p>
      ) : (
        <ul className={styles.grid} aria-label="Images">
          {shown.map((image) => {
            const picture = (
              <>
                {/* The server's own route, which serves it as the type its bytes are. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className={styles.thumb}
                  src={imageUrl(connectionId, image.path)}
                  alt=""
                  loading="lazy"
                  onLoad={(event) => {
                    // Read now: the event is not there when React runs the update.
                    const dimensions = `${event.currentTarget.naturalWidth}×${event.currentTarget.naturalHeight}`;
                    setPixels((current) => ({ ...current, [image.path]: dimensions }));
                  }}
                />
                <span className={styles.caption}>
                  {image.name}
                  <span className={styles.meta}>
                    {size(image.size)}
                    {pixels[image.path] ? ` · ${pixels[image.path]}` : ''}
                  </span>
                </span>
              </>
            );
            return (
              <li
                key={image.path}
                className={`${styles.tile} ${selected === image.path ? styles.selected : ''}`}
              >
                {mode === 'choose' ? (
                  <button
                    type="button"
                    className={styles.pick}
                    aria-pressed={selected === image.path}
                    aria-label={`Choose ${image.name}`}
                    onClick={() => {
                      setSelected(image.path);
                      setAlt('');
                      setDecorative(false);
                    }}
                  >
                    {picture}
                  </button>
                ) : (
                  <>
                    <a
                      className={styles.pick}
                      href={imageUrl(connectionId, image.path)}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open ${image.name}`}
                    >
                      {picture}
                    </a>
                    <span className={styles.remove}>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        aria-label={`Delete ${image.name}`}
                        onClick={() => void onRemove(image)}
                      >
                        <Icon name="trash-2" aria-hidden />
                      </Button>
                    </span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {mode === 'choose' && chosen ? (
        <form
          className={styles.choose}
          aria-label={`Use ${chosen.name}`}
          onSubmit={(event) => {
            event.preventDefault();
            if (mayInsert)
              onChoose?.({
                path: chosen.path,
                name: chosen.name,
                alt: decorative ? '' : alt.trim(),
              });
          }}
        >
          <div className={styles.alt}>
            <FormField
              label="Describe the image"
              hint="For people who cannot see it, and when it does not load."
            >
              {(field) => (
                <Input
                  {...field}
                  name="alt"
                  autoComplete="off"
                  autoFocus
                  value={alt}
                  onChange={(event) => setAlt(event.target.value)}
                  disabled={decorative}
                />
              )}
            </FormField>
          </div>
          <label>
            <input
              type="checkbox"
              checked={decorative}
              onChange={(event) => setDecorative(event.target.checked)}
            />{' '}
            Only for looks, no description
          </label>
          <Button type="submit" disabled={!mayInsert}>
            Insert
          </Button>
        </form>
      ) : null}
      {asking}
    </div>
  );
}
