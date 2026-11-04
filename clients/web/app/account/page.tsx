import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Security was `/account` (it is `/security`): the old address still arrives, with what it carried. `tab=security` is what the page now opens on without being told. */
export default async function AccountPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<never> {
  const query = await searchParams;
  const carried = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) if (typeof value === "string" && !(name === "tab" && value === "security")) carried.set(name, value);
  redirect(carried.size === 0 ? "/security" : `/security?${carried.toString()}`);
}
