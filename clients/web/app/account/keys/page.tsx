import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** The key's own page was folded into the account (`/account`), as a tab. The address still arrives. */
export default function KeysPage(): never {
  redirect("/account?tab=keys");
}
