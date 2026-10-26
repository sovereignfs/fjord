import type { Provider, RepositoryRef } from "../providers/types";

/**
 * The text of a small file, by blob id. A blob never changes, so what has been read is kept, in memory, for the
 * life of the process: a vault's manifest is read once however often its repository is looked at (DESIGN.md §8,
 * "cached by blob id"). Bounded, oldest out first, so it cannot grow without limit.
 */
const KEY = Symbol.for("fjord.blobText");
const LIMIT = 500;
type Holder = { [KEY]?: Map<string, string> };

export async function blobText(provider: Provider, ref: RepositoryRef, blob: string, maxBytes: number): Promise<string> {
  const holder = globalThis as Holder;
  const cache = (holder[KEY] ??= new Map());
  // Per repository too: two repositories can hold the same blob id, and only one may be readable by this credential.
  const key = `${provider.name}/${ref.owner}/${ref.name}/${blob}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const bytes = await provider.readBlob(ref, blob, { maxBytes });
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  cache.set(key, text);
  if (cache.size > LIMIT) cache.delete(cache.keys().next().value as string);
  return text;
}

/** For tests. */
export function forgetBlobTexts(): void {
  (globalThis as Holder)[KEY]?.clear();
}
