import { notFound, redirect } from "next/navigation";
import { requireSession } from "../../auth/server";
import { isLegacyId, isPublicId } from "../../connections/public-id";
import { connectionService } from "../../connections/server";
import { parseAddress } from "../addresses";
import { decodeSegments, repositoryHref } from "../links";
import { safeSegments } from "../location";
import { RecentlyDeletedScreen } from "./RecentlyDeletedScreen";
import { RepositoryScreen } from "./RepositoryScreen";

export type RepositoryKindInAddress = "drive" | "journal" | "ssg";

const searchOf = (query: Record<string, string | string[] | undefined>) =>
  new URLSearchParams(Object.entries(query).flatMap(([key, value]) => (typeof value === "string" ? [[key, value]] : Array.isArray(value) ? value.map((each) => [key, each] as [string, string]) : []))).toString();

/**
 * One of the account's own repositories, and a place inside it, at an address that begins with the repository's kind (the owner's request after the first screens): `/drive/<repo>`,
 * `/journal/<repo>`, `/ssg/<repo>`, and in each a vault `…/v/<vault-id>`, a folder or a file in it by its id (workstream 0003, `src/browse/addresses.ts`). A repository is at the one that is
 * its kind now: an address of another kind (a drive's, once it was made a journal) is sent to it, with the rest of the address and the query kept. The three routes under `app/` are this.
 */
export async function RepositoryRoute({ kind, params, searchParams }: { kind: RepositoryKindInAddress; params: Promise<{ connection: string; path?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { connection, path } = await params;
  const query = await searchParams;
  const view = typeof query.view === "string" ? query.view : undefined;
  const decoded = decodeSegments(path);
  if (path !== undefined && path.length > 0 && decoded === undefined) notFound();
  if (!isPublicId(connection)) notFound();
  const parsed = parseAddress(decoded ?? []);
  if (parsed.kind === "invalid") notFound();
  const base = `${kind}/${connection}`;
  if (parsed.kind === "deleted") return <RecentlyDeletedScreen connection={connection} />;
  if (parsed.kind === "vault" || parsed.kind === "place" || parsed.kind === "note") {
    return <RepositoryScreen connection={connection} urlKind={kind} address={parsed} requested={`/${base}/${(decoded ?? []).map(encodeURIComponent).join("/")}`} via="address" view={view} query={query} />;
  }
  const segments = parsed.kind === "legacy" ? parsed.segments : undefined;
  // The old address by path: where it is its own canonical address (a vault with no `id` has none of ids), it is not sent on.
  return <RepositoryScreen connection={connection} urlKind={kind} path={segments} requested={segments !== undefined ? repositoryHref(base, ...segments) : `/${base}`} view={view} query={query} />;
}

/**
 * `/repo/<repo>/…`, which every address was before it began with the kind: sent to the address of the repository's kind, by its public id or by the number it was connected as before
 * that, with the rest of the address and the query. Someone else's repository, or one that is not there, is a 404, as it is behind the new address.
 */
export async function repositoryRedirect({ params, searchParams }: { params: Promise<{ connection: string; path?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<never> {
  const { connection, path } = await params;
  const query = await searchParams;
  const decoded = decodeSegments(path);
  if (path !== undefined && path.length > 0 && decoded === undefined) notFound();
  if (!isLegacyId(connection) && !isPublicId(connection)) notFound();
  const { user } = await requireSession();
  const service = await connectionService();
  const known = isLegacyId(connection) ? await service.get(user.id, Number(connection)) : await service.getByPublicId(user.id, connection);
  // A segment that is a way out of the repository is no more an address here than it is behind the new one.
  if (!known || (decoded !== undefined && safeSegments(decoded) === undefined)) notFound();
  const search = searchOf(query);
  redirect(`${repositoryHref(known.address, ...(decoded ?? []))}${search === "" ? "" : `?${search}`}`);
}
