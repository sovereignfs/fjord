"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authConfig } from "../../../src/auth/server";
import { PUBLICATION_COOKIE, PUBLICATION_COOKIE_SECONDS } from "../../../src/publishing/unlock";
import { unlockPublishedFor } from "../../../src/publishing/server";
import { TOKEN_PATTERN } from "../../../src/sharing/tokens";

/**
 * Giving the password of a published page, from the form the page shows. A server action, because it sets a cookie for the page's own path. Wrong, too soon and gone all go back to
 * the page's address, which says which in words; the password is never in an address.
 */
export async function unlockPageAction(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  if (!TOKEN_PATTERN.test(token)) redirect("/");
  const password = formData.get("password");
  const result = await unlockPublishedFor(token, typeof password === "string" ? password : undefined);
  if (result.ok) {
    const config = authConfig();
    (await cookies()).set(PUBLICATION_COOKIE, result.proof, { httpOnly: true, sameSite: "lax", secure: config.enabled && config.url.startsWith("https://"), path: `/p/${token}`, maxAge: PUBLICATION_COOKIE_SECONDS });
    redirect(`/p/${token}`);
  }
  redirect(result.reason === "gone" ? `/p/${token}` : `/p/${token}?wrong=${result.reason === "wait" ? "wait" : "1"}`);
}
