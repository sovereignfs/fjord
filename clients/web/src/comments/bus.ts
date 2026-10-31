/**
 * Telling the streams that watch a document that its comments changed (ROADMAP 1d.3), in this process, at once. It is a convenience and nothing
 * depends on it: a stream also asks the database, which is how a change made by another process (a second replica) reaches it, a few seconds later.
 * (PostgreSQL's `LISTEN`/`NOTIFY` is not used: SQLite has no such thing, DESIGN.md §14.)
 *
 * There is one bus per process, held on `globalThis` because Next may load this module more than once (a copy for each route's bundle) and a
 * change made through one must reach a stream opened through another.
 */
export class CommentBus {
  private readonly watchers = new Map<string, Set<() => void>>();

  private static key(connectionId: number, docId: string): string {
    return `${connectionId}:${docId}`;
  }

  /** Be told when the document's comments change. Returns how to stop being. */
  subscribe(connectionId: number, docId: string, listener: () => void): () => void {
    const key = CommentBus.key(connectionId, docId);
    const set = this.watchers.get(key) ?? new Set<() => void>();
    set.add(listener);
    this.watchers.set(key, set);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.watchers.get(key) === set) this.watchers.delete(key);
    };
  }

  publish(connectionId: number, docId: string): void {
    for (const listener of [...(this.watchers.get(CommentBus.key(connectionId, docId)) ?? [])]) {
      try {
        listener();
      } catch {
        // One watcher failing must not keep the rest from being told.
      }
    }
  }

  /** How many watchers there are, for tests. */
  get size(): number {
    let n = 0;
    for (const set of this.watchers.values()) n += set.size;
    return n;
  }
}

const SLOT = Symbol.for("fjord.commentBus");
export function commentBus(): CommentBus {
  const holder = globalThis as unknown as Record<symbol, CommentBus | undefined>;
  return (holder[SLOT] ??= new CommentBus());
}
