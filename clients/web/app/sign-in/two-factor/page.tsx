import { notFound, redirect } from "next/navigation";
import { AuthShell } from "../../../src/auth/screens/AuthShell";
import { TwoFactorForm } from "../../../src/auth/screens/TwoFactorForm";
import { getSession, localAuthConfig } from "../../../src/auth/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Two-factor code" };

export default async function TwoFactorPage() {
  const config = localAuthConfig();
  if (!config) notFound();
  if (await getSession()) redirect("/");

  return (
    <AuthShell title="Check it is you" lead="Your password was right. One more step." footer={<a href="/sign-in">Back to sign in</a>}>
      <TwoFactorForm />
    </AuthShell>
  );
}
