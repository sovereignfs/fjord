import type { ReactNode } from "react";
import type { ConnectionInfo } from "../../connections/service";
import { AppShell, type ShellPlace } from "../../ui/AppShell";
import { authConfig, localAuthConfig } from "../server";
import { SignOutButton } from "./SignOutButton";

/**
 * The frame of a signed-in page (`AppShell`) with what this instance knows to put in it: its name, whether there are security
 * settings, the way out, and the repositories the person has connected, as icons to move between them.
 */
export function SignedInShell({ user, connections, place, children }: { user: { name: string; email: string }; connections: Pick<ConnectionInfo, "id" | "owner" | "name" | "isDefault" | "repoKind">[]; place: ShellPlace; children: ReactNode }) {
  const config = authConfig();
  return (
    <AppShell
      name={config.enabled ? config.name : "Fjord"}
      person={user}
      repositories={connections.map((connection) => ({ id: connection.id, label: `${connection.owner}/${connection.name}`, isDefault: connection.isDefault, kind: connection.repoKind }))}
      place={place}
      security={localAuthConfig() !== undefined}
      signOut={<SignOutButton icon />}
    >
      {children}
    </AppShell>
  );
}
