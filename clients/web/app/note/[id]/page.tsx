import { IdPage } from "../../../src/browse/screens/IdPage";

export const dynamic = "force-dynamic";
export const metadata = { title: "Note" };

/** A note by its Doc `id`, wherever it is among the account's repositories (ROADMAP 1b.6). */
export default async function NoteByIdPage({ params }: { params: Promise<{ id: string }> }) {
  return <IdPage route="note" id={(await params).id} />;
}
