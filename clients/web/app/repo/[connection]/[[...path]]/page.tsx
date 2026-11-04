import { notFound, redirect } from "next/navigation";
import { requireSession } from "../../../../src/auth/server";
import { isLegacyId, isPublicId } from "../../../../src/connections/public-id";
import { connectionService } from "../../../../src/connections/server";
import { parseAddress } from "../../../../src/browse/addresses";
import { decodeSegments, repositoryHref } from "../../../../src/browse/links";
import { safeSegments } from "../../../../src/browse/location";
import { RecentlyDeletedScreen } from "../../../../src/browse/screens/RecentlyDeletedScreen";
import { RepositoryScreen } from "../../../../src/browse/screens/RepositoryScreen";

export const dynamic = "force-dynamic";
export const metadata = { title: "Repository" };

/**
 * One of the account's own repositories, and a place inside it (see `RepositoryScreen`): `/repo/<repo>`, a vault `/repo/<repo>/v/<vault>`, a folder or a file in it
 * by its id (workstream 0003, `src/browse/addresses.ts`). What was `/repo/<repo>/<path…>` is still answered, by sending the person to the place's address of ids.
 */
export default async function RepositoryPage({ params, searchParams }: { params: Promise<{ connection: string; path?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { connection, path } = await params;
  const query = await searchParams;
  const view = typeof query.view === "string" ? query.view : undefined;
  const decoded = decodeSegments(path);
  if (path !== undefined && path.length > 0 && decoded === undefined) notFound();
  // A repository used to be called by the number it was connected as (`/repo/3`): that still leads to it, by its own name now.
  if (isLegacyId(connection)) {
    const { user } = await requireSession();
    const known = await (await connectionService()).get(user.id, Number(connection));
    // A segment that is a way out of the repository is no more an address here than it is behind the new one.
    if (!known || (decoded !== undefined && safeSegments(decoded) === undefined)) notFound();
    const search = new URLSearchParams(Object.entries(query).flatMap(([key, value]) => (typeof value === "string" ? [[key, value]] : Array.isArray(value) ? value.map((each) => [key, each] as [string, string]) : []))).toString();
    redirect(`${repositoryHref(known.publicId, ...(decoded ?? []))}${search === "" ? "" : `?${search}`}`);
  }
  const parsed = parseAddress(decoded ?? []);
  if (parsed.kind === "invalid") notFound();
  if (parsed.kind === "deleted") return <RecentlyDeletedScreen connection={connection} />;
  if (parsed.kind === "vault" || parsed.kind === "place" || parsed.kind === "note") {
    return <RepositoryScreen connection={connection} address={parsed} requested={`/repo/${connection}/${(decoded ?? []).map(encodeURIComponent).join("/")}`} via="address" view={view} query={query} />;
  }
  const segments = parsed.kind === "legacy" ? parsed.segments : undefined;
  // The old address by path: where it is its own canonical address (a vault with no `id` has none of ids), it is not sent on.
  return <RepositoryScreen connection={connection} path={segments} requested={isPublicId(connection) && segments !== undefined ? repositoryHref(connection, ...segments) : undefined} view={view} query={query} />;
}
