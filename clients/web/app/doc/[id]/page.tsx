import { IdPage } from "../../../src/browse/screens/IdPage";

export const dynamic = "force-dynamic";
// A link carries its token in the address (ROADMAP 1c.3): nothing on the page may pass it on in a `Referer` (1c.4 sets the header too).
export const metadata = { title: "Document", referrer: "no-referrer" };

/** A document by its Doc `id`, wherever it is among the account's repositories, or by a share link's `?token=` (ROADMAP 1b.6, 1c.3). */
export default async function DocumentByIdPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ token?: string | string[] }> }) {
  const { token } = await searchParams;
  return <IdPage route="doc" id={(await params).id} token={typeof token === "string" ? token : undefined} />;
}
