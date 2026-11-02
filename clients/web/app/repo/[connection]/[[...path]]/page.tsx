import { notFound } from "next/navigation";
import { decodeSegments } from "../../../../src/browse/links";
import { RepositoryScreen } from "../../../../src/browse/screens/RepositoryScreen";

export const dynamic = "force-dynamic";
export const metadata = { title: "Repository" };

/** One of the account's own repositories, and a place inside it (see `RepositoryScreen`). */
export default async function RepositoryPage({ params, searchParams }: { params: Promise<{ connection: string; path?: string[] }>; searchParams: Promise<{ view?: string | string[] }> }) {
  const { connection, path } = await params;
  const { view } = await searchParams;
  const decoded = decodeSegments(path);
  if (path !== undefined && path.length > 0 && decoded === undefined) notFound();
  return <RepositoryScreen connection={connection} path={decoded} view={typeof view === "string" ? view : undefined} />;
}
