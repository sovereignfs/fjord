import { notFound } from "next/navigation";
import { parseAddress } from "../../../../src/browse/addresses";
import { decodeSegments, repositoryHref } from "../../../../src/browse/links";
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
  const parsed = parseAddress(decoded ?? []);
  if (parsed.kind === "invalid") notFound();
  if (parsed.kind === "vault" || parsed.kind === "place") {
    return <RepositoryScreen connection={connection} address={parsed} requested={`/repo/${connection}/${(decoded ?? []).map(encodeURIComponent).join("/")}`} via="address" view={view} query={query} />;
  }
  const segments = parsed.kind === "legacy" ? parsed.segments : undefined;
  // The old address by path: where it is its own canonical address (a vault with no `id` has none of ids), it is not sent on.
  return <RepositoryScreen connection={connection} path={segments} requested={/^[1-9][0-9]{0,15}$/.test(connection) && segments !== undefined ? repositoryHref(Number(connection), ...segments) : undefined} view={view} query={query} />;
}
