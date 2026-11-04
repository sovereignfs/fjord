import type { Metadata } from "next";
import { getSession } from "../../auth/server";
import { connectionLabel } from "../../connections/label";
import { isPublicId } from "../../connections/public-id";
import { connectionService } from "../../connections/server";
import { getDatabase } from "../../db/boot";
import { type Address, parseAddress } from "../addresses";
import { DocIndex } from "../doc-index";
import { FileHandles } from "../handles";
import { decodeSegments } from "../links";

const FALLBACK: Metadata = { title: "Repository" };

/** What a tab is called on a place in a repository: `report · acme/notes`. It is a file's or folder's name, found from what is already held and never by asking the git host, so it costs a page one or two reads of the database. */
export function placeTitle(repository: string, place: string | undefined): string {
  return place === undefined || place === "" ? repository : `${place} · ${repository}`;
}

/** The last step of a path, with a Doc's `.md` or `.fj.md` off it: what a person calls the file. */
export function placeName(path: string): string {
  const leaf = path.slice(path.lastIndexOf("/") + 1);
  return leaf.replace(/(\.fj)?\.md$/i, "");
}

async function placeOf(address: Address, connectionId: number): Promise<string | undefined> {
  if (address.kind === "deleted") return "Recently deleted";
  if (address.kind === "legacy") return address.segments.length > 0 ? placeName(address.segments[address.segments.length - 1] as string) : undefined;
  if (address.kind !== "place" && address.kind !== "note") return undefined;
  const database = await getDatabase();
  const target = address.target as { handle: string } | { doc: string } | { html: string };
  if ("doc" in target) {
    const found = await new DocIndex(database).find([connectionId], target.doc);
    return found[0] ? placeName(found[0].file.path) : undefined;
  }
  const place = await new FileHandles(database).resolve("html" in target ? target.html : target.handle);
  return place?.connectionId === connectionId ? placeName(place.path) : undefined;
}

/**
 * The `metadata` of a repository's pages (`/drive`, `/journal`, `/ssg`). Someone else's repository, or none, is called what any repository is: the name says nothing that the page
 * would not, and a failure here is not worth a page.
 */
export async function repositoryMetadata({ params }: { params: Promise<{ connection: string; path?: string[] }> }): Promise<Metadata> {
  try {
    const { connection, path } = await params;
    if (!isPublicId(connection)) return FALLBACK;
    const session = await getSession();
    if (!session) return FALLBACK;
    const listed = (await (await connectionService()).list(session.user.id)).find((candidate) => candidate.publicId === connection);
    if (!listed) return FALLBACK;
    const decoded = decodeSegments(path);
    const place = decoded === undefined ? undefined : await placeOf(parseAddress(decoded), listed.id);
    return { title: placeTitle(connectionLabel(listed), place) };
  } catch {
    return FALLBACK;
  }
}
