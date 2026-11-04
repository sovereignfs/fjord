import { notFound, redirect } from "next/navigation";
import { localAuthConfig } from "../../../src/auth/server";

export const dynamic = "force-dynamic";

/**
 * The security page is a section of the account (`/account?section=security`). The address still arrives, with what it carried (the way back from linking
 * Sovereign says what happened in `error`, `linked` and `unlinked`). An instance with no local sign-in has no such settings, and it is still not found.
 */
export default async function AccountSecurityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<never> {
  if (!localAuthConfig()) notFound();
  const query = await searchParams;
  const carried = new URLSearchParams({ section: "security" });
  for (const name of ["error", "linked", "unlinked"]) if (typeof query[name] === "string") carried.set(name, query[name] as string);
  redirect(`/account?${carried.toString()}`);
}
