import { notFound } from "next/navigation";
import { decodeSegments } from "../../../../src/browse/links";
import { RepositoryScreen } from "../../../../src/browse/screens/RepositoryScreen";

export const dynamic = "force-dynamic";
export const metadata = { title: "Repository" };

/** One of the account's own repositories, and a place inside it (see `RepositoryScreen`). */
export default async function RepositoryPage({ params }: { params: Promise<{ connection: string; path?: string[] }> }) {
  const { connection, path } = await params;
  const decoded = decodeSegments(path);
  if (path !== undefined && path.length > 0 && decoded === undefined) notFound();
  return <RepositoryScreen connection={connection} path={decoded} />;
}
