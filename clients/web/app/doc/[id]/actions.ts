"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authConfig } from "../../../src/auth/server";
import { isDocId } from "../../../src/browse/ids";
import { PENDING_COOKIE, SHARE_COOKIE } from "../../../src/sharing/redact";
import { unlockFor } from "../../../src/sharing/server";

/**
 * Giving the password of a share link (ROADMAP 1c.5), from the form the page shows. A server action, because it sets a cookie for the
 * document's own path and the pending cookie that holds the link's token is sent only there. Next checks the form came from this site.
 * Wrong, too soon and gone all go back to the clean address, which says which in words; the password is never in an address.
 */
export async function unlockAction(formData: FormData): Promise<void> {
  const docId = String(formData.get("doc") ?? "");
  if (!isDocId(docId)) redirect("/");
  const password = formData.get("password");
  const jar = await cookies();
  const result = await unlockFor(docId, typeof password === "string" ? password : undefined, jar.get(PENDING_COOKIE)?.value);
  if (result.ok) {
    const config = authConfig();
    const options = { httpOnly: true, sameSite: "lax", secure: config.enabled && config.url.startsWith("https://"), path: `/doc/${docId}` } as const;
    jar.set(SHARE_COOKIE, result.value, { ...options, maxAge: result.maxAgeSeconds });
    jar.set(PENDING_COOKIE, "", { ...options, maxAge: 0 });
    redirect(`/doc/${docId}`);
  }
  redirect(result.reason === "gone" ? `/doc/${docId}` : `/doc/${docId}?wrong=${result.reason === "wait" ? "wait" : "1"}`);
}
