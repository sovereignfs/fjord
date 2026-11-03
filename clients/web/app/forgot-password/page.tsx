import { notFound, redirect } from "next/navigation";
import { AuthShell } from "../../src/auth/screens/AuthShell";
import { ForgotPasswordForm } from "../../src/auth/screens/ResetForms";
import { AuthLink } from "../../src/ui";
import { getSession, localAuthConfig } from "../../src/auth/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reset your password" };

export default async function ForgotPasswordPage() {
  const config = localAuthConfig();
  // No mail, no reset by email: there is nothing to send the link with.
  if (!config?.smtp) notFound();
  if (await getSession()) redirect("/");

  return (
    <AuthShell title="Reset password" name={config.name} lead="Enter your account email and we will send a link to choose a new password. The link works for an hour." footer={<AuthLink href="/sign-in">Back to sign in</AuthLink>}>
      <ForgotPasswordForm />
    </AuthShell>
  );
}
