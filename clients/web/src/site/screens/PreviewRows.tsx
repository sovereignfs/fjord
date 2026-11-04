import { Badge, Button } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import type { PreviewOutcome, PreviewView } from "../preview";
import { momentText } from "../../ui/dates";

/**
 * A site's previews as the page says them (ROADMAP 3d.1): each with where it stands, in words a person can act on. A preview is a branch the host
 * builds; Fjord only reports what the host says of it. Pure, so that every state is tested from a recorded answer.
 */
export function describe(outcome: PreviewOutcome): { label: string; text: string; busy: boolean } {
  switch (outcome.kind) {
    case "waiting":
      return { label: "Waiting", text: "Your host has been told. It has not said it is building this yet.", busy: true };
    case "building":
      return { label: "Building", text: "Your host is building the preview.", busy: true };
    case "ready":
      return { label: "Ready", text: "Built.", busy: false };
    case "built":
      return { label: "Built", text: "Your host built it, and did not say where the preview is. Look in its dashboard.", busy: false };
    case "failed":
      return { label: "Failed", text: "The build failed, so there is no preview.", busy: false };
    case "unsupported":
      return {
        label: "Not built",
        text: "Your host has not built this branch. Hosts like Cloudflare Pages, Netlify and Vercel build every branch; GitHub Pages does not. Stop this preview, and look at your host's settings for branch previews.",
        busy: false,
      };
    case "unreadable":
      return { label: "Unknown", text: "This repository's token cannot read what the host reports, so how the preview stands is not known here. Give it read access to Checks, Commit statuses and Deployments.", busy: false };
  }
}

const when = (at: number) => momentText(at);

export function PreviewRows({ previews, onStop, stopping }: { previews: PreviewView[]; onStop?: ((branch: string) => void) | undefined; stopping?: string | null | undefined }) {
  if (previews.length === 0) return null;
  return (
    <ul className={styles.list} aria-label="Your previews" data-testid="previews">
      {previews.map((preview) => {
        const said = describe(preview.outcome);
        const link = preview.outcome.kind === "ready" ? preview.outcome.url : preview.outcome.kind === "failed" ? preview.outcome.url : undefined;
        return (
          <li key={preview.branch} className={styles.item} data-testid="preview">
            <span>
              Started {when(preview.startedAt)} <Badge>{said.label}</Badge>
              <span className={styles.itemMeta} style={{ display: "block" }}>
                {said.text}{" "}
                {link ? (
                  <a href={link} target="_blank" rel="noopener noreferrer">
                    {preview.outcome.kind === "ready" ? "Open the preview" : "See why"}
                  </a>
                ) : null}
              </span>
            </span>
            {onStop ? (
              <Button variant="secondary" size="sm" loading={stopping === preview.branch} onClick={() => onStop(preview.branch)}>
                Stop previewing
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
