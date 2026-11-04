import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** The key's own page was folded into Security (`/security`), as the second tab. The address still arrives. */
export default function KeysPage(): never {
  redirect("/security?tab=keys");
}
