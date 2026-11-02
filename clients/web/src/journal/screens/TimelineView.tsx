import { repositoryHref } from "../../browse/links";
import { Badge } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import type { Timeline } from "../timeline";

/**
 * A journal's timeline as the page shows it (ROADMAP 3b.2): its entries newest first under the day each is about, with the title and
 * the start of each. The same for a plaintext journal, arranged on the server, and an encrypted one, arranged in the browser.
 */
export function TimelineView({
  connectionId,
  timeline,
  tagHref,
  empty = "No entries yet.",
}: {
  connectionId: number;
  timeline: Timeline;
  /** Where a tag leads, to narrow the timeline to it (3b.3); none, no links. */
  tagHref?: (tag: string) => string;
  /** What is said when there is nothing to show: "No posts yet." for a site. */
  empty?: string;
}) {
  if (timeline.total === 0) return <p className={styles.itemMeta}>{empty}</p>;
  return (
    <div data-testid="timeline">
      {timeline.days.map((day) => (
        <section key={day.day ?? "undated"} aria-label={day.day ?? "Not dated"}>
          <h3>{day.day === null ? "Not dated" : formatDay(day.day)}</h3>
          <ul className={styles.list}>
            {day.entries.map((entry) => (
              <li key={entry.path} className={styles.item} data-testid="timeline-entry">
                <span>
                  <a href={repositoryHref(connectionId, ...entry.path.split("/"))}>
                    {entry.when?.time ? <time dateTime={entry.when.sortKey}>{entry.when.time}</time> : null} {entry.title}
                  </a>
                  {entry.draft ? (
                    <>
                      {" "}
                      <Badge>Draft</Badge>
                    </>
                  ) : null}
                  {entry.dateInvalid ? (
                    <>
                      {" "}
                      <Badge>W606: its date is not one</Badge>
                    </>
                  ) : null}
                  {entry.tags.length > 0 ? (
                    <span className={styles.itemMeta}>
                      {" "}
                      {entry.tags.map((tag) =>
                        tagHref ? (
                          <a key={tag} href={tagHref(tag)} style={{ marginRight: "0.5em" }}>
                            #{tag}
                          </a>
                        ) : (
                          <span key={tag} style={{ marginRight: "0.5em" }}>
                            #{tag}
                          </span>
                        ),
                      )}
                    </span>
                  ) : null}
                  {entry.excerpt ? <span className={styles.itemMeta} style={{ display: "block" }}>{entry.excerpt}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** `2026-11-02` as the page says it, without asking the browser's clock or time zone: the day is the writer's, as written. */
function formatDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${date} ${names[month - 1] ?? month} ${year}`;
}
