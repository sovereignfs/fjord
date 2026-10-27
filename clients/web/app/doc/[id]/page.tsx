import { IdPage } from "../../../src/browse/screens/IdPage";

export const dynamic = "force-dynamic";
export const metadata = { title: "Document" };

/**
 * A document by its Doc `id`, wherever it is among the account's repositories, or by a share link (ROADMAP 1b.6, 1c.3). A link's `?token=`
 * never reaches this page: `proxy.ts` swaps it for a cookie and redirects here without it (1c.4). The one query it takes is `wrong`, set
 * when the password of a link was not right (1c.5), which holds no secret.
 */
export default async function DocumentByIdPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ wrong?: string | string[] }> }) {
  const { wrong } = await searchParams;
  return <IdPage route="doc" id={(await params).id} wrong={wrong === "wait" ? "wait" : wrong === undefined ? undefined : "wrong"} />;
}
