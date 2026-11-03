import type { ReactNode } from "react";
import { BrandBadge, Icon, type IconName } from "./index";
import { markOf, monogram } from "./brand";
import { RepositoryKindIcon, type RepositoryKindId } from "./icons";
import styles from "./AppShell.module.css";

/** A connected repository, for its icon in the rail. */
export interface ShellRepository {
  id: string | number;
  /** `owner/name`. */
  label: string;
  /** The one `/` opens on: its tooltip says so, since the rail has no room for a badge. */
  isDefault?: boolean;
  /** What it is, for its icon: a drive, a journal or a site. Not known until it has been opened once; shown as a drive. */
  kind?: RepositoryKindId | null;
}

/** Where a signed-in person is, so its icon in the rail is marked as the current page. */
export type ShellPlace = "index" | "repositories" | "keys" | "security" | { repository: string | number };

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

function RailLink({ href, label, tip, active, icon, children }: { href: string; label: string; tip?: string; active: boolean; icon?: IconName; children?: ReactNode }) {
  return (
    <a href={href} className={classes(styles.icon, active && styles.iconActive)} title={tip ?? label} aria-label={label} aria-current={active ? "page" : undefined}>
      {icon ? <Icon name={icon} aria-hidden /> : children}
    </a>
  );
}

/**
 * The frame of a signed-in page: two columns, a narrow rail and the page, with the page filling the rest and at least the height
 * of the viewport. In the rail, from the top: the instance's mark, the Index (the home page: a tile for each repository), an icon for each
 * repository, by its kind, to move between them, and a way to connect another; at the foot, the account's own places and the way out.
 *
 * It is made here, with nothing from the design system but its icons (`lucide`'s, in its curated set, so they recolour with the theme),
 * its mark and its tokens, because the design system has no shell. Sovereign's own shell is the model (its rail is 64px, with 40px icons). **Worth offering to `@sovereignfs/ui`** (as an
 * `AppRail` or `AppShell`) once a second app wants the same: it is app-agnostic apart from these props.
 *
 * The sign-out control is given, because signing out is the auth client's, which this component does not know.
 */
export function AppShell({
  name,
  person,
  repositories,
  place,
  security,
  signOut,
  children,
}: {
  /** The instance's name (`FJORD_NAME`), whose first two letters are the mark. */
  name: string;
  /** Who is signed in. */
  person: { name: string; email: string };
  repositories: ShellRepository[];
  place: ShellPlace;
  /** Whether there is a page of security settings (the local methods' passwords, two-factor and passkeys). */
  security: boolean;
  signOut: ReactNode;
  children: ReactNode;
}) {
  const current = typeof place === "object" ? String(place.repository) : undefined;
  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <a href="/" className={styles.brand} title={name} aria-label={name}>
          <BrandBadge name={name} mark={markOf(name)} />
        </a>
        <hr className={styles.divider} />
        <nav className={styles.top} aria-label="Repositories">
          <RailLink href="/" label="Repositories" icon="layout-grid" active={place === "index"} />
        </nav>
        <ul className={styles.repositories} aria-label="Your repositories">
          {repositories.map((repository) => (
            <li key={repository.id}>
              <RailLink href={`/repo/${repository.id}`} label={repository.label} tip={repository.isDefault ? `${repository.label} (default)` : repository.label} active={current === String(repository.id)}>
                <RepositoryKindIcon kind={repository.kind ?? null} />
              </RailLink>
            </li>
          ))}
          <li>
            <RailLink href="/repositories" label="Connect a repository" icon="plus" active={place === "repositories"} />
          </li>
        </ul>
        <nav className={styles.chrome} aria-label="Account">
          <RailLink href="/account/keys" label="Keys" icon="lock" active={place === "keys"} />
          {security ? <RailLink href="/account/security" label="Security" icon="shield" active={place === "security"} /> : null}
          {signOut}
          <span className={styles.avatar} title={`${person.name} · ${person.email}`} role="img" aria-label={person.name}>
            {monogram(person.name)}
          </span>
        </nav>
      </aside>
      <main className={styles.content}>{children}</main>
    </div>
  );
}
