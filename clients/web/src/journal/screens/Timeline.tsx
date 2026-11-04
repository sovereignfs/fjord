import { repositoryHref } from "../../browse/links";
import type { RepositoryRead } from "../../browse/repository";
import { describeProblem } from "../../browse/problems";
import { connectionService } from "../../connections/server";
import type { ConnectionInfo } from "../../connections/service";
import { getDatabase } from "../../db/boot";
import { fjord } from "../../format/wasm";
import type { VaultListing } from "../../format/types";
import { Alert } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import { JournalIndex } from "../index-store";
import { type TimelineFilter, arrange, summaries } from "../timeline";
import { QueryTagFilter } from "./TagFilter";
import { TimelineView } from "./TimelineView";

/**
 * A plaintext journal's timeline (ROADMAP 3b.2, 3b.3), arranged on the server from what is known of each entry by its blob: the page reads
 * from the host only the entries it has not read before. `query` is the page's: `page`, `tag` (any number), `from` and `to`.
 */
export async function Timeline({ accountId, connection, read, vault, query, empty, docBase }: {
  empty?: string; docBase?: "n" | "post"; accountId: string; connection: ConnectionInfo; read: RepositoryRead; vault: VaultListing; query: Record<string, string | string[] | undefined> }) {
  const used = await (await connectionService()).provider(accountId, connection.id);
  if (!used) return null;
  let entries;
  try {
    entries = await summaries({ provider: used.provider, ref: { owner: connection.owner, name: connection.name }, format: fjord(), index: new JournalIndex(await getDatabase()) }, connection.id, vault, read.blobs);
  } catch (error) {
    const problem = describeProblem(error);
    if (!problem) throw error;
    return <Alert variant="error" heading="The journal cannot be read right now">{problem.message}</Alert>;
  }
  const list = (value: string | string[] | undefined) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
  const one = (value: string | string[] | undefined) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined);
  const filter: TimelineFilter = { tags: list(query.tag).slice(0, 20), from: one(query.from), to: one(query.to) };
  const page = Number.parseInt(typeof query.page === "string" ? query.page : "1", 10);
  const timeline = arrange(fjord(), entries, { page: Number.isFinite(page) ? page : 1, filter });

  const base = repositoryHref(connection.address);
  const address = (extra: Record<string, string>) => {
    const params = new URLSearchParams();
    for (const tag of filter.tags ?? []) params.append("tag", tag);
    if (filter.from) params.set("from", filter.from);
    if (filter.to) params.set("to", filter.to);
    for (const [key, value] of Object.entries(extra)) params.set(key, value);
    const text = params.toString();
    return text === "" ? base : `${base}?${text}`;
  };
  const tagHref = (tag: string) => `${base}?${new URLSearchParams([["tag", tag]]).toString()}`;
  const range = { ...(filter.from ? { from: filter.from } : {}), ...(filter.to ? { to: filter.to } : {}) };
  return (
    <>
      <QueryTagFilter base={base} tags={timeline.tags} chosen={filter.tags ?? []} range={range} />
      <TimelineView connectionId={connection.id} repo={connection.address} timeline={timeline} tagHref={tagHref} {...(empty ? { empty } : {})} {...(docBase ? { docBase } : {})} />
      {timeline.pages > 1 ? (
        <p className={styles.actions}>
          {timeline.page > 1 ? <a href={address({ page: String(timeline.page - 1) })}>Newer</a> : null}
          <span className={styles.itemMeta}> Page {timeline.page} of {timeline.pages} </span>
          {timeline.page < timeline.pages ? <a href={address({ page: String(timeline.page + 1) })}>Older</a> : null}
        </p>
      ) : null}
    </>
  );
}
