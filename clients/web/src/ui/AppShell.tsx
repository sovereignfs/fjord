import type { ReactNode } from 'react';
import { BrandBadge, Icon, type IconName } from '@sovereignfs/ui';
import { markOf } from './brand';
import { RepositoryKindIcon, type RepositoryKindId } from './icons';
import styles from './AppShell.module.css';

/** A connected repository, for its icon in the rail. */
export interface ShellRepository {
  /** The repository's public id, which is its address (`/repo/<id>`). */
  id: string;
  /** `owner/name`. */
  label: string;
  /** The one `/` opens on: its tooltip says so, since the rail has no room for a badge. */
  isDefault?: boolean;
  /** What it is, for its icon: a drive, a journal or a site. Not known until it has been opened once; shown as a drive. */
  kind?: RepositoryKindId | null;
}

/** Where a signed-in person is, so its icon in the rail is marked as the current page. */
export type ShellPlace = 'index' | 'repositories' | 'account' | 'shared' | { repository: string };

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');

function RailLink({
  href,
  label,
  tip,
  active,
  icon,
  children,
}: {
  href: string;
  label: string;
  tip?: string;
  active: boolean;
  icon?: IconName;
  children?: ReactNode;
}) {
  return (
    <a
      href={href}
      className={classes(styles.icon, active && styles.iconActive)}
      title={tip ?? label}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
    >
      {icon ? <Icon name={icon} aria-hidden /> : children}
    </a>
  );
}

/**
 * The frame of a signed-in page: two columns, a narrow rail and the page, with the page filling the rest and at least the height
 * of the viewport. In the rail, from the top: the instance's mark, the Index (the home page: a tile for each repository), an icon for each
 * repository, by its kind, to move between them, and a way to connect another; at the foot, the person's own menu (`account`: who they are, their account, the way out).
 *
 * It is made here, with nothing from the design system but its icons (`lucide`'s, in its curated set, so they recolour with the theme),
 * its mark and its tokens, because the design system has no shell. Sovereign's own shell is the model (its rail is 64px, with 40px icons). **Worth offering to `@sovereignfs/ui`** (as an
 * `AppRail` or `AppShell`) once a second app wants the same: it is app-agnostic apart from these props.
 *
 * The menu is given, because what it does (open the account as a dialog, sign out) is the auth client's and the router's, which this component does not know.
 */
export function AppShell({
  name,
  repositories,
  place,
  connect,
  account,
  shared = false,
  children,
}: {
  /** The instance's name (`FJORD_NAME`), whose first two letters are the mark. */
  name: string;
  repositories: ShellRepository[];
  place: ShellPlace;
  /** The rail's `+`: a button that opens the dialog to connect a repository. Given, because the dialog is a client component with the form's own knowledge. */
  connect: ReactNode;
  /** The person's menu, at the foot of the rail: their avatar, which opens who they are, their account and the way out. */
  account: ReactNode;
  /** Whether anything is shared with this person: then the rail has *Shared with you*, a place of its own among the repositories, whose files stay with their owners. */
  shared?: boolean;
  children: ReactNode;
}) {
  const current = typeof place === 'object' ? place.repository : undefined;
  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <a href="/" className={styles.brand} title={name} aria-label={name}>
          <BrandBadge name={name} mark={markOf(name)} />
        </a>
        <hr className={styles.divider} />
        <nav className={styles.top} aria-label="Repositories">
          <RailLink href="/" label="Repositories" icon="layout-grid" active={place === 'index'} />
        </nav>
        <ul className={styles.repositories} aria-label="Your repositories">
          {repositories.map((repository) => (
            <li key={repository.id}>
              <RailLink
                href={`/${repository.kind ?? 'drive'}/${repository.id}`}
                label={repository.label}
                tip={repository.isDefault ? `${repository.label} (default)` : repository.label}
                active={current === repository.id}
              >
                <RepositoryKindIcon kind={repository.kind ?? null} />
              </RailLink>
            </li>
          ))}
          {shared || place === 'shared' ? (
            <li>
              <RailLink
                href="/shared"
                label="Shared with you"
                icon="users"
                active={place === 'shared'}
              />
            </li>
          ) : null}
          <li>{connect}</li>
        </ul>
        <nav className={styles.chrome} aria-label="Account">
          {account}
        </nav>
      </aside>
      <main className={styles.content}>{children}</main>
    </div>
  );
}
