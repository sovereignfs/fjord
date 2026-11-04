import { requireSession } from "../../auth/server";
import type { ConnectionInfo } from "../../connections/service";
import { LocalUsage } from "./LocalUsage";
import { SyncForm } from "./SyncForm";

/**
 * What a repository's settings say when it is kept on this server (ROADMAP 3i): that it is, how much of the person's allowance is used,
 * and the way to connect it to git. Only for a connection of the signed-in account, which is the only kind a repository page shows.
 */
export async function LocalSettings({ current }: { current: ConnectionInfo }) {
  const { user } = await requireSession();
  return (
    <section aria-label="Stored on this server">
      <h2>Stored on this server</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sv-space-3)" }}>
        <p style={{ margin: 0 }}>This repository is kept on this server, not in a git repository, and is nowhere else. Move it to a git repository to back it up and to use it with other tools.</p>
        <LocalUsage accountId={user.id} />
        <SyncForm id={current.id} name={current.name} />
      </div>
    </section>
  );
}
