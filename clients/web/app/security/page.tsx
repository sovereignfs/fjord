import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Security was `/security`, and is a section of the account: the address still arrives, with what it carried (`tab=keys`, and what the way back from linking Sovereign says). */
export default async function SecurityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<never> {
  const query = await searchParams;
  const carried = new URLSearchParams({ section: "security" });
  for (const [name, value] of Object.entries(query)) if (typeof value === "string" && name !== "section") carried.set(name, value);
  redirect(`/account?${carried.toString()}`);
}
