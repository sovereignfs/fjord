import type { ReactNode } from "react";
import { ConnectDialog } from "../../connections/screens/ConnectDialog";
import type { ConnectionInfo } from "../../connections/service";
import { connectionService } from "../../connections/server";
import { encryptionKeyring } from "../../crypto/server";
import { sharedCountFor } from "../../sharing/count";
import { AppShell, type ShellPlace } from "../../ui/AppShell";
import { authConfig } from "../server";
import { AccountMenu } from "./AccountMenu";

type Listed = Pick<ConnectionInfo, "id" | "publicId" | "owner" | "name" | "isDefault" | "repoKind">;

/**
 * The frame of a signed-in page (`AppShell`) with what this instance knows to put in it: its name, the dialog that connects a repository, the way out, and the
 * repositories the person has connected, as icons to move between them. A page that has the list already passes it; one that has not leaves it out and it is read here.
 */
export async function SignedInShell({ user, connections, place, children }: { user: { id?: string; name: string; email: string; image?: string | null | undefined }; connections?: Listed[]; place: ShellPlace; children: ReactNode }) {
  const config = authConfig();
  const canConnect = encryptionKeyring() !== undefined;
  const listed = connections ?? (canConnect && user.id !== undefined ? await (await connectionService()).list(user.id) : []);
  const shared = user.id !== undefined && canConnect ? (await sharedCountFor(user.id)) > 0 : false;
  return (
    <AppShell
      shared={shared}
      name={config.enabled ? config.name : "Fjord"}
      repositories={listed.map((connection) => ({ id: connection.publicId, label: `${connection.owner}/${connection.name}`, isDefault: connection.isDefault, kind: connection.repoKind }))}
      place={place}
      connect={<ConnectDialog canConnect={canConnect} />}
      account={<AccountMenu name={user.name} email={user.email} {...(user.image ? { avatarUrl: user.image } : {})} />}
    >
      {children}
    </AppShell>
  );
}
