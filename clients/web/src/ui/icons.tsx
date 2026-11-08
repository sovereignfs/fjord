import { Icon, type IconName } from '@sovereignfs/ui';
import type { CSSProperties, SVGProps } from 'react';
import styles from './icons.module.css';

/**
 * The design system's icons (`IconName` in `@sovereignfs/ui`), at the sizes the app draws them, and the one icon the set does not have.
 *
 * `Icon` comes in four sizes (12, 16, 20 and 24px) and the app draws icons at others too (14, 18, 28), so `SetIcon` boxes it at a size in
 * pixels and the icon fills the box. Every icon here is decorative: what it means is said by the text or the label beside it.
 */
export function SetIcon({
  name,
  size = 20,
  className,
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={[styles.box, className].filter(Boolean).join(' ')}
      style={{ width: size, height: size, ...style }}
      aria-hidden="true"
    >
      <Icon name={name} aria-hidden />
    </span>
  );
}

/**
 * Lucide's `globe-code` (https://lucide.dev, ISC licence), which `@sovereignfs/ui`'s set does not have (it is newer than the Lucide the set is
 * made from), drawn as the set draws its own: a 24px grid, `currentColor` strokes. Worth offering to the package once it takes a newer Lucide.
 */
function Svg({ size = 20, children, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  );
}

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number };

/** A site built by a static site generator. */
export function GlobeCodeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15.5 10 13 7.5 15.5 5" />
      <path d="M15.861 14A14.5 14.5 0 0112 22a14.48 14.48 0 010-20 10 10 0 109.888 11.5" />
      <path d="M19.5 5 22 7.5 19.5 10" />
      <path d="M2 12h8.5" />
    </Svg>
  );
}

/** What a repository is, as a picture: a drive's, a journal's or a site's. A repository whose kind is not known yet is a drive. */
export type RepositoryKindId = 'drive' | 'journal' | 'ssg';

export function RepositoryKindIcon({
  kind,
  size = 20,
}: {
  kind: RepositoryKindId | null;
  size?: number;
}) {
  if (kind === 'journal') return <SetIcon name="notebook-pen" size={size} />;
  if (kind === 'ssg') return <GlobeCodeIcon aria-hidden="true" size={size} />;
  return <SetIcon name="hard-drive" size={size} />;
}

export const KIND_LABEL: Record<RepositoryKindId, string> = {
  drive: 'Drive',
  journal: 'Journal',
  ssg: 'Site',
};
