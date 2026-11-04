import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** The key's own page is the second part of the account's Security section. The address still arrives. */
export default function KeysPage(): never {
  redirect("/account?section=security&tab=keys");
}
