import type { ReactNode } from "react";
import { ConnectDialog } from "../../connections/screens/ConnectDialog";
import type { ConnectionInfo } from "../../connections/service";
import { connectionService } from "../../connections/server";
import { encryptionKeyring } from "../../crypto/server";
import { AppShell, type ShellPlace } from "../../ui/AppShell";
import { authConfig } from "../server";
import { SignOutButton } from "./SignOutButton";

type Listed = Pick<ConnectionInfo, "id" | "owner" | "name" | "isDefault" | "repoKind">;

/**
 * The frame of a signed-in page (`AppShell`) with what this instance knows to put in it: its name, the dialog that connects a repository, the way out, and the
 * repositories the person has connected, as icons to move between them. A page that has the list already passes it; one that has not leaves it out and it is read here.
 */
export async function SignedInShell({ user, connections, place, children }: { user: { id?: string; name: string; email: string }; connections?: Listed[]; place: ShellPlace; children: ReactNode }) {
  const config = authConfig();
  const canConnect = encryptionKeyring() !== undefined;
  const listed = connections ?? (canConnect && user.id !== undefined ? await (await connectionService()).list(user.id) : []);
  return (
    <AppShell
      name={config.enabled ? config.name : "Fjord"}
      person={user}
      repositories={listed.map((connection) => ({ id: connection.id, label: `${connection.owner}/${connection.name}`, isDefault: connection.isDefault, kind: connection.repoKind }))}
      place={place}
      connect={<ConnectDialog canConnect={canConnect} />}
      signOut={<SignOutButton icon />}
    >
      {children}
    </AppShell>
  );
}
