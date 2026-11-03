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
    <AuthShell title="Two-factor verification" name={config.name} lead="Your password was right. One more step.">
      <TwoFactorForm />
    </AuthShell>
  );
}
