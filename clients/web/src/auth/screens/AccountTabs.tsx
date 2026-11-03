"use client";

import { type ReactNode, useState } from "react";
import { Tabs } from "../../ui";

/**
 * The account's two parts under one set of tabs: the key kept in this browser, and the security of the sign-in. Both are rendered by the server and handed in, so
 * switching tabs is only showing one of them; the one that is not shown is kept mounted, so a half-typed passphrase is not lost by looking at the other. With
 * no security part (an instance that signs in only through Sovereign has none) there is one panel and no tabs.
 */
export function AccountTabs({ initial, keys, security }: { initial: "keys" | "security"; keys: ReactNode; security: ReactNode | null }) {
  const [tab, setTab] = useState<"keys" | "security">(security === null ? "keys" : initial);
  if (security === null) return <>{keys}</>;
  return (
    <div>
      <Tabs
        aria-label="Account"
        value={tab}
        onChange={(value) => setTab(value === "security" ? "security" : "keys")}
        items={[
          { value: "keys", label: "Encryption identity" },
          { value: "security", label: "Security" },
        ]}
      />
      <div hidden={tab !== "keys"} style={{ paddingTop: "var(--sv-space-5)" }}>
        {keys}
      </div>
      <div hidden={tab !== "security"} style={{ paddingTop: "var(--sv-space-5)" }}>
        {security}
      </div>
    </div>
  );
}
