/**
 * The offer to undo a deletion, carried from the page that deleted to the one that follows it (ROADMAP 1b.12): the numbers of
 * the deletions and a name for them, in the browser's session storage for that tab, read once. Nothing here is trusted: what
 * the numbers do is decided by the server, for the person's own repository only, and a number someone made up puts back
 * nothing. Storage can be missing or refuse (a private window); then the offer is simply not made, and Recently deleted has it.
 */
export interface UndoOffer {
  ids: number[];
  label: string;
}

const key = (connectionId: number) => `fjord:undo:${connectionId}`;

export function rememberUndo(storage: Pick<Storage, "setItem">, connectionId: number, offer: UndoOffer): void {
  try {
    storage.setItem(key(connectionId), JSON.stringify(offer));
  } catch {
    // Not remembered: no Undo, only Recently deleted.
  }
}

/** The offer, once: it is gone after it is read. Undefined if there is none, or it is not one. */
export function takeUndo(storage: Pick<Storage, "getItem" | "removeItem">, connectionId: number): UndoOffer | undefined {
  try {
    const raw = storage.getItem(key(connectionId));
    if (raw === null) return undefined;
    storage.removeItem(key(connectionId));
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { ids, label } = parsed as Record<string, unknown>;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 1000 || !ids.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0) || typeof label !== "string") return undefined;
    return { ids: ids as number[], label: label.slice(0, 200) };
  } catch {
    return undefined;
  }
}
