"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authConfig } from "../../../src/auth/server";
import { isDocId } from "../../../src/browse/ids";
import { SHARE_SCOPES } from "../../../src/sharing/enter";
import { cookieNames } from "../../../src/sharing/redact";
import { unlockFor } from "../../../src/sharing/server";

/**
 * Giving the password of a share link (ROADMAP 1c.5), from the form the page shows. A server action, because it sets a cookie for the
 * document's own path and the pending cookie that holds the link's token is sent only there. Next checks the form came from this site.
 * Wrong, too soon and gone all go back to the clean address, which says which in words; the password is never in an address.
 */
export async function unlockAction(formData: FormData): Promise<void> {
  const docId = String(formData.get("doc") ?? "");
  if (!isDocId(docId)) redirect("/");
  // The address it was asked at: `/d/<id>`, or `/n/<id>` for a journal's note.
  const base = formData.get("base") === "n" ? "n" : "d";
  const password = formData.get("password");
  const jar = await cookies();
  const result = await unlockFor(docId, typeof password === "string" ? password : undefined, jar.get(cookieNames(base).pending)?.value);
  if (result.ok) {
    const config = authConfig();
    for (const scope of SHARE_SCOPES) {
      const options = { httpOnly: true, sameSite: "lax", secure: config.enabled && config.url.startsWith("https://"), path: `/${scope}/${docId}` } as const;
      jar.set(cookieNames(scope).share, result.value, { ...options, maxAge: result.maxAgeSeconds });
      jar.set(cookieNames(scope).pending, "", { ...options, maxAge: 0 });
    }
    redirect(`/${base}/${docId}`);
  }
  redirect(result.reason === "gone" ? `/${base}/${docId}` : `/${base}/${docId}?wrong=${result.reason === "wait" ? "wait" : "1"}`);
}
