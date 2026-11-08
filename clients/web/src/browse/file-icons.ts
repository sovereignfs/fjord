import type { IconName } from '@sovereignfs/ui';
import type { FileKind } from '../format/types';

/**
 * Which icon a file is drawn with in a listing (the owner's request after workstream 0003): by what it is, from its **name** alone, as everything in a listing is, so that nothing is
 * read to draw it. The names are the design system's (`IconName`), so one it does not have does not compile.
 *
 * It is a table and not a chain of tests so that a new kind of file is one line: add its extensions to `BY_EXTENSION`.
 * A name that is not in the table is a plain file. The icon of an encrypted file is its real name's (`plan.md.age` is a Markdown file that is encrypted, and says so with a badge).
 */
export const FILE_ICON = {
  folder: 'folder-closed',
  folderOpen: 'folder-open',
  vault: 'folder',
  encryptedVault: 'folder-lock',
  file: 'file',
} as const satisfies Record<string, IconName>;

const BY_EXTENSION: Record<string, IconName> = {
  md: 'file-text',
  markdown: 'file-text',
  png: 'file-image',
  jpg: 'file-image',
  jpeg: 'file-image',
  gif: 'file-image',
  webp: 'file-image',
  avif: 'file-image',
  svg: 'file-image',
  bmp: 'file-image',
  ico: 'file-image',
  heic: 'file-image',
  tif: 'file-image',
  tiff: 'file-image',
  pdf: 'square-text',
  html: 'file-code-corner',
  htm: 'file-code-corner',
};

/** The icon for a file called `name` (a Doc is Markdown whatever else; an encrypted file by the name inside the suffix). */
export function fileIconFor(name: string, kind?: FileKind): IconName {
  if (kind === 'doc') return 'file-text';
  const bare = kind === 'payload' ? name.replace(/\.age$/i, '') : name;
  const dot = bare.lastIndexOf('.');
  const extension = dot > 0 ? bare.slice(dot + 1).toLowerCase() : '';
  return BY_EXTENSION[extension] ?? FILE_ICON.file;
}
