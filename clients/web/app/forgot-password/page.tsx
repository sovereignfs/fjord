import { notFound, redirect } from "next/navigation";
import { AuthShell } from "../../src/auth/screens/AuthShell";
import { ForgotPasswordForm } from "../../src/auth/screens/ResetForms";
import { getSession, localAuthConfig } from "../../src/auth/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reset your password" };

export default async function ForgotPasswordPage() {
  const config = localAuthConfig();
  // No mail, no reset by email: there is nothing to send the link with.
  if (!config?.smtp) notFound();
  if (await getSession()) redirect("/");

  return (
    <AuthShell title="Forgot your password?" lead="Enter your email address and we will send you a link to choose a new one." footer={<a href="/sign-in">Back to sign in</a>}>
      <ForgotPasswordForm />
    </AuthShell>
  );
}
