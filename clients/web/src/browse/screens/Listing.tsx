"use client";

import { type ReactNode, useEffect, useState } from "react";
import { Badge } from "../../ui";
import { NodeIcon } from "../../ui/icons";
import styles from "./Listing.module.css";

/** One row (or tile) of a listing: what it is, where it leads, and what to say of it. Plain data, so the server can make a listing of anything and this draws it. */
export interface ListingItem {
  key: string;
  name: string;
  /** Where it opens; none for a file nothing opens in this version, which is drawn greyed. */
  href?: string | undefined;
  /** Lucide's name for its icon (`browse/file-icons.ts` chooses it). */
  icon: string;
  /** The icon it has when it is pointed at, for a folder that is about to be opened. */
  hoverIcon?: string | undefined;
  /** Short labels after the name: what kind of file it is, that it is encrypted, that it opens first. */
  badges?: string[] | undefined;
  /** What to say of it that is not a label: how many files are in it, how large it is. */
  meta?: string | undefined;
  /** Why it is greyed. */
  title?: string | undefined;
  /** Something of its own at the end: a button that works on this one. */
  trailing?: ReactNode;
}

type View = "list" | "grid";
const STORAGE_KEY = "fjord.listing.view";

/**
 * The listing of a repository's vaults, or of a vault's folders and files, as rows or as tiles, with a toggle for which at its top right and the actions that make or change
 * things (`actions`) at its top left. The choice is the person's and is kept in this browser (it is a convenience: without storage it is rows). The server draws rows first, and
 * the choice is applied once the page is in the browser.
 */
export function Listing({ label, items, actions, empty }: { label: string; items: ListingItem[]; /** The buttons at the top left; what they open goes below them. */ actions?: ReactNode; /** What to say when there is nothing in it. */ empty?: ReactNode }) {
  const [view, setView] = useState<View>("list");
  useEffect(() => {
    try {
      const kept = window.localStorage.getItem(STORAGE_KEY);
      if (kept === "grid" || kept === "list") setView(kept);
    } catch {
      // No storage: rows.
    }
  }, []);
  function choose(next: View) {
    setView(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not kept; it still applies to this page.
    }
  }

  return (
    <>
      <div className={styles.toolbar}>
        <div className={styles.actions}>{actions}</div>
        <div className={styles.toggle} role="group" aria-label="View">
          <button type="button" aria-pressed={view === "list"} aria-label="List view" title="List view" onClick={() => choose("list")}>
            <NodeIcon name="list" size={18} aria-hidden />
          </button>
          <button type="button" aria-pressed={view === "grid"} aria-label="Grid view" title="Grid view" onClick={() => choose("grid")}>
            <NodeIcon name="layout-grid" size={18} aria-hidden />
          </button>
        </div>
      </div>
      {items.length === 0 ? (
        (empty ?? null)
      ) : (
        <ul className={view === "grid" ? styles.grid : styles.list} data-view={view} aria-label={label}>
          {items.map((item) => (
            <li key={item.key} className={`${styles.item} ${item.href === undefined ? styles.disabled : ""}`} title={item.href === undefined ? item.title : undefined} aria-disabled={item.href === undefined ? true : undefined}>
              <span className={styles.icon} aria-hidden="true" data-icon={item.icon}>
                <span className={styles.closed}>
                  <NodeIcon name={item.icon} />
                </span>
                {item.hoverIcon ? (
                  <span className={styles.open}>
                    <NodeIcon name={item.hoverIcon} />
                  </span>
                ) : null}
              </span>
              <span className={styles.body}>
                {item.href === undefined ? (
                  <span className={styles.name}>{item.name}</span>
                ) : (
                  <a className={styles.name} href={item.href}>
                    {item.name}
                  </a>
                )}
                {(item.badges ?? []).map((badge) => (
                  <Badge key={badge}>{badge}</Badge>
                ))}
                {item.meta ? <span className={styles.meta}>{item.meta}</span> : null}
              </span>
              {item.trailing ? <span className={styles.trailing}>{item.trailing}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
