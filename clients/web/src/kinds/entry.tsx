import type { Outcome } from "../browse/server";
import type { ConnectionInfo } from "../connections/service";
import { driveKind } from "./drive";
import { kindFor } from "./registry";
import type { KindModule } from "./types";

/**
 * What a repository opens on, and as which kind (RFC 0001): its kind's entry view, or, with `files`, the drive's, which every kind
 * can be shown as. Nothing for a repository that could not be read: the page says why instead.
 */
export function entryFor(accountId: string, connection: ConnectionInfo, outcome: Outcome, files = false): { kind: KindModule; presented: KindModule; entry: React.ReactNode } {
  const kind = outcome.ok ? kindFor(outcome.read.manifest) : driveKind;
  const presented = files ? driveKind : kind;
  if (!outcome.ok) return { kind, presented, entry: undefined };
  const { EntryView } = presented;
  return { kind, presented, entry: <EntryView accountId={accountId} connection={connection} read={outcome.read} /> };
}
