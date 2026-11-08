"use client";

import type { ImageChoice, ImageSource } from "fjord-editor";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { Alert, Dialog } from "../../ui";
import { fetchDisplayUrl, fetchReference } from "../images-client";
import { MediaLibrary } from "./MediaLibrary";

interface Asking {
  /** Bumped for each question, so that the library starts again from nothing. */
  key: number;
  /** Pictures pasted or dropped into the text, which go up as soon as the library is open. */
  files: File[] | undefined;
}

/**
 * The editors' picture source for one post of a site (RFC 0004, ROADMAP 3j.3, 3j.4): what `fjord-editor` asks for, answered with the site's media
 * library in a dialog. A chosen picture is turned into the reference the site's engine reads by the server (`/images/reference`, the format module's
 * `siteImageRef`), so neither the editor nor this file knows an engine's path rules. Without `enabled` there is no source and nothing is drawn.
 *
 * Draw `dialog` once, anywhere in the page.
 */
export function useSiteImages(connectionId: number, post: string, enabled: boolean): { source: ImageSource | undefined; dialog: ReactNode } {
  const [asking, setAsking] = useState<Asking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answer = useRef<((choice: ImageChoice | null) => void) | null>(null);
  const counter = useRef(0);
  const shown = useRef(new Map<string, Promise<string>>());

  const settle = useCallback((choice: ImageChoice | null) => {
    answer.current?.(choice);
    answer.current = null;
    setAsking(null);
    setError(null);
  }, []);

  const ask = useCallback((files: File[] | undefined) => {
    // A second question while one is open gives the first up: the person is looking at the library, which is the one to answer.
    answer.current?.(null);
    return new Promise<ImageChoice | null>((resolve) => {
      answer.current = resolve;
      counter.current += 1;
      setError(null);
      setAsking({ key: counter.current, files });
    });
  }, []);

  const source = useMemo<ImageSource | undefined>(
    () =>
      enabled
        ? {
            choose: () => ask(undefined),
            add: (files) => ask(files),
            resolve: (reference) => {
              const known = shown.current.get(reference);
              if (known) return known;
              const looked = fetchDisplayUrl(connectionId, post, reference);
              shown.current.set(reference, looked);
              return looked;
            },
          }
        : undefined,
    [enabled, ask, connectionId, post],
  );

  const dialog = asking ? (
    <Dialog open onClose={() => settle(null)} size="lg" aria-label="Choose an image" title="Choose an image">
      {error ? (
        <div style={{ padding: "var(--sv-space-5) var(--sv-space-5) 0" }}>
          <Alert variant="error" heading="The image was not put in">
            {error}
          </Alert>
        </div>
      ) : null}
      <MediaLibrary
        key={asking.key}
        connectionId={connectionId}
        mode="choose"
        {...(asking.files ? { initialFiles: asking.files } : {})}
        onChoose={(chosen) => {
          void fetchReference(connectionId, post, chosen.path).then((made) => {
            if (made.ok) settle({ reference: made.reference, alt: chosen.alt });
            else setError(made.message);
          });
        }}
      />
    </Dialog>
  ) : null;

  return { source, dialog };
}
