import { notFound } from "next/navigation";
import { FileHandles, isHandle } from "../../../src/browse/handles";
import { RepositoryScreen } from "../../../src/browse/screens/RepositoryScreen";
import { requireSession } from "../../../src/auth/server";
import { connectionService } from "../../../src/connections/server";
import { getDatabase } from "../../../src/db/boot";

export const dynamic = "force-dynamic";
export const metadata = { title: "Repository" };

/**
 * A file or a folder that has no Doc `id`, by an opaque handle (DESIGN.md §9, ROADMAP 3e.2, RFC 0002): the address of a place that shows no path. The
 * handle says where in which repository; whether it is the account's own is asked as for `/repo/…`, so another account's handle is a 404 and says nothing.
 * A Doc is sent on to `/d/<id>` by the screen, and a path with nothing at it says it was moved or deleted.
 */
export default async function FilePage({ params, searchParams }: { params: Promise<{ handle: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { handle } = await params;
  const query = await searchParams;
  const { user } = await requireSession();
  if (!isHandle(handle)) notFound();
  const place = await new FileHandles(await getDatabase()).resolve(handle);
  if (!place) notFound();
  // Only a repository of this account's: any other is a 404, as for the same address by path.
  const mine = (await (await connectionService()).list(user.id)).some((connection) => connection.id === place.connectionId);
  if (!mine) notFound();
  return <RepositoryScreen connection={String(place.connectionId)} path={place.path.split("/")} via="handle" query={query} />;
}
