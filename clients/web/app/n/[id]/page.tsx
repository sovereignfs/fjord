import { IdPage } from '../../../src/browse/screens/IdPage';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Note' };

/**
 * A journal's note by its `id` (workstream 0003): the address a note is shared at, as `/d/<id>` is a document's. It is the same page, for the same document and the same
 * links, with the same rules: the owner is sent to the note's address inside its repository (`/repo/<repo>/n/<id>`), and someone it is shared with, or a link's visitor, reads it here.
 * A link's `?token=` never reaches it: `proxy.ts` swaps it for a cookie and redirects here without it.
 */
export default async function NoteByIdPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ wrong?: string | string[] }>;
}) {
  const { wrong } = await searchParams;
  return (
    <IdPage
      id={(await params).id}
      base="n"
      wrong={wrong === 'wait' ? 'wait' : wrong === undefined ? undefined : 'wrong'}
    />
  );
}
