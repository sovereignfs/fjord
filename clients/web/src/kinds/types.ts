import type { ReactNode } from "react";
import type { ConnectionInfo } from "../connections/service";
import type { RepositoryRead } from "../browse/repository";

/**
 * A kind of repository, as Fjord Web presents it (RFC 0001, DESIGN.md §8 "Repository kinds"). A kind is a presentation of the same
 * format (spec §3.1): what a repository opens on, what a new one contains, where a new item goes and which fields it has, and what
 * the kind adds beyond editing. Everything else (the editors, versions, sharing, comments, encryption) is shared and the same for
 * every kind, so a new kind is a new module and not a change to the others.
 */
export interface KindModule {
  /** `fjord.json`'s `kind`: the registry's key. */
  id: string;
  /** What the person sees it called. The client's, not the format's: "Drive", "Journal", "Site". */
  label: string;
  /** What the repository opens on, at `/repo/<connection>` with no path. */
  EntryView: (props: EntryViewProps) => ReactNode | Promise<ReactNode>;
  /** Where a new item goes and which frontmatter fields it has. */
  contentModel: ContentModel;
  /** What the kind adds beyond editing, shown on its entry view. Empty for a drive. */
  actions: KindAction[];
}

/** What every entry view is given: the repository as read at its head, and whose it is. */
export interface EntryViewProps {
  accountId: string;
  connection: ConnectionInfo;
  read: RepositoryRead;
  /** The page's query, for an entry view that pages or filters (a journal's timeline: `page`, `tag`, `from`, `to`). */
  query: Record<string, string | string[] | undefined>;
}

export interface ContentModel {
  /**
   * Where a new item goes: `anywhere` (a drive: the person chooses a folder), `dated` (a journal: from its `date`, spec §8.1), or
   * `engine` (a site: where its engine looks, by the engine's rules).
   */
  placement: "anywhere" | "dated" | "engine";
  /** The frontmatter keys the kind gives a new item a field for, beyond `id`, in the order they are shown. */
  fields: string[];
}

export interface KindAction {
  /** A stable name, for tests and for the page's keys. */
  id: string;
  label: string;
}
