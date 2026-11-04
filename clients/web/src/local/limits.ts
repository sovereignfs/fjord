/**
 * What an account may keep on this server before it connects a repository to git (ROADMAP 3i, DESIGN.md §7a), so that nobody can fill
 * the server with repositories that are not in a git host. Three limits, all per account, all settings of the instance:
 *
 *  - `FJORD_LOCAL_MAX_REPOSITORIES` (default 3): how many server-side repositories. `0` turns the feature off.
 *  - `FJORD_LOCAL_MAX_MIB` (default 50): the bytes of every file they hold now, in MiB.
 *  - `FJORD_LOCAL_MAX_FILES` (default 2000): the files they hold now.
 *
 * A value that is not a whole number in range is not used, and the default is (as `FJORD_RESTORE_WINDOW_DAYS` is read), so a typo
 * never removes a limit.
 */
export interface LocalLimits {
  repositories: number;
  /** Bytes. */
  bytes: number;
  files: number;
}

export const DEFAULT_LOCAL_LIMITS: LocalLimits = { repositories: 3, bytes: 50 * 1024 * 1024, files: 2000 };

const MIB = 1024 * 1024;

function whole(raw: string | undefined, min: number, max: number, fallback: number): number {
  const text = (raw ?? "").trim();
  if (!/^[0-9]{1,9}$/.test(text)) return fallback;
  const value = Number(text);
  return value >= min && value <= max ? value : fallback;
}

export function localLimits(env: Record<string, string | undefined> = process.env): LocalLimits {
  return {
    repositories: whole(env.FJORD_LOCAL_MAX_REPOSITORIES, 0, 1000, DEFAULT_LOCAL_LIMITS.repositories),
    bytes: whole(env.FJORD_LOCAL_MAX_MIB, 1, 100_000, DEFAULT_LOCAL_LIMITS.bytes / MIB) * MIB,
    files: whole(env.FJORD_LOCAL_MAX_FILES, 1, 1_000_000, DEFAULT_LOCAL_LIMITS.files),
  };
}

/** Bytes as a person reads them: `3.2 MiB`, `48 KiB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MIB) return `${Math.round(bytes / 1024)} KiB`;
  const mib = bytes / MIB;
  return `${mib >= 10 ? Math.round(mib) : Math.round(mib * 10) / 10} MiB`;
}

/** What an account holds on this server, and what it may. */
export interface LocalUsage {
  repositories: number;
  files: number;
  bytes: number;
  limits: LocalLimits;
}

/** Which limit a request ran into: the words for it, so that a person knows what to do. */
export type LimitKind = "repositories" | "files" | "bytes";

export function limitMessage(kind: LimitKind, limits: LocalLimits): string {
  switch (kind) {
    case "repositories":
      return limits.repositories === 0
        ? "This instance does not keep repositories on the server. Connect a git repository instead."
        : `You can keep ${limits.repositories} ${limits.repositories === 1 ? "repository" : "repositories"} on this server until you connect them to git, and you have that many. Connect one to a git repository (which moves its files there and frees the space), or delete one, then try again.`;
    case "files":
      return `Repositories on this server can hold ${limits.files} files in all, and this would go over. Connect one to a git repository to move its files out, or delete some files, then try again.`;
    case "bytes":
      return `Repositories on this server can hold ${formatBytes(limits.bytes)} in all, and this would go over. Connect one to a git repository to move its files out, or delete some files, then try again.`;
  }
}
