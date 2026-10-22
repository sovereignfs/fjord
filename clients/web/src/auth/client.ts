"use client";

import { passkeyClient } from "@better-auth/passkey/client";
import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * better-auth in the browser, talking to /api/auth on the same origin. When a password is
 * right but the account has two-factor on, the server answers with a challenge instead of a
 * session, and this sends the person to the page that asks for the code.
 */
export const authClient = createAuthClient({
  plugins: [
    twoFactorClient({
      onTwoFactorRedirect() {
        window.location.assign("/sign-in/two-factor");
      },
    }),
    passkeyClient(),
  ],
});
