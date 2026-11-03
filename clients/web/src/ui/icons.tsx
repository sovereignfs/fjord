import type { SVGProps } from "react";

/**
 * Icons from Lucide (https://lucide.dev, ISC licence) that `@sovereignfs/ui`'s curated set does not have yet, drawn as it draws its own: 24px
 * grid, `currentColor` strokes. Paths are Lucide's, from `lucide@1.67.0`. Worth offering to the package (`packages/ui/src/components/Icon/icons`,
 * made by its `scripts/generate-icons.ts`) once a second app wants them; they are kept here until then.
 */
function Svg({ size = 20, children, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      {children}
    </svg>
  );
}

type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number };

/** A drive: files and folders in vaults. */
export function HardDriveIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 16h.01" />
      <path d="M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      <path d="M21.946 12.013H2.054" />
      <path d="M6 16h.01" />
    </Svg>
  );
}

/** A journal: dated entries. */
export function NotebookPenIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4" />
      <path d="M2 6h4" />
      <path d="M2 10h4" />
      <path d="M2 14h4" />
      <path d="M2 18h4" />
      <path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z" />
    </Svg>
  );
}

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

/** Who you are to this instance: your account, its security and the key kept in this browser. */
export function FingerprintPatternIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" />
      <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
      <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
      <path d="M2 12a10 10 0 0 1 18-6" />
      <path d="M2 16h.01" />
      <path d="M21.8 16c.2-2 .131-5.354 0-6" />
      <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" />
      <path d="M8.65 22c.21-.66.45-1.32.57-2" />
      <path d="M9 6.8a6 6 0 0 1 9 5.2v2" />
    </Svg>
  );
}

/** What a repository is, as a picture: a drive's, a journal's or a site's. A repository whose kind is not known yet is a drive. */
export type RepositoryKindId = "drive" | "journal" | "ssg";

export function RepositoryKindIcon({ kind, ...props }: IconProps & { kind: RepositoryKindId | null }) {
  if (kind === "journal") return <NotebookPenIcon aria-hidden="true" {...props} />;
  if (kind === "ssg") return <GlobeCodeIcon aria-hidden="true" {...props} />;
  return <HardDriveIcon aria-hidden="true" {...props} />;
}

export const KIND_LABEL: Record<RepositoryKindId, string> = { drive: "Drive", journal: "Journal", ssg: "Site" };
