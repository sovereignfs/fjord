"use client";

import { useState } from "react";
import { authClient } from "../client";
import { Button } from "../../ui";

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        await authClient.signOut();
        window.location.assign("/");
      }}
    >
      Sign out
    </Button>
  );
}
