import type { RepositoryRef } from "../providers/types";

/**
 * The last head a connection's branch was seen at, with the host's `ETag` for it, kept in this process (DESIGN.md §8, ROADMAP 1a.6
 * afterwards). A view asks the host for the head with `If-None-Match`; a `304` says it has not moved, and costs the host no rate limit,
 * so looking at a repository again is free while nothing is pushed. It is **always right**: what is kept is only what the host said, and
 * the host is still asked at every view, so a missed webhook, or a process that never had one, shows a push at the next look. Nothing here
 * is trusted past that question. Bounded, and the oldest goes first.
 */
export const MAX_HEADS = 1000;

export interface KnownHead {
  etag: string;
  commit: string;
}

export class HeadCache {
  private readonly kept = new Map<string, KnownHead>();

  constructor(private readonly max: number = MAX_HEADS) {}

  private key(connectionId: number, ref: RepositoryRef, branch: string): string {
    return `${connectionId}\u0000${ref.owner}/${ref.name}\u0000${branch}`;
  }

  get(connectionId: number, ref: RepositoryRef, branch: string): KnownHead | undefined {
    const key = this.key(connectionId, ref, branch);
    const known = this.kept.get(key);
    if (known) {
      // Recently used goes last.
      this.kept.delete(key);
      this.kept.set(key, known);
    }
    return known;
  }

  put(connectionId: number, ref: RepositoryRef, branch: string, head: KnownHead): void {
    const key = this.key(connectionId, ref, branch);
    this.kept.delete(key);
    this.kept.set(key, head);
    while (this.kept.size > this.max) this.kept.delete(this.kept.keys().next().value as string);
  }

}

/** The process's own, shared by every request. */
export const heads = new HeadCache();
