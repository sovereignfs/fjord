import { notFound } from "next/navigation";
import { AuthShell } from "../../src/auth/screens/AuthShell";
import { ResetPasswordForm } from "../../src/auth/screens/ResetForms";
import { localAuthConfig } from "../../src/auth/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  const config = localAuthConfig();
  if (!config?.smtp) notFound();
  const { token, error } = await searchParams;

  // The link better-auth emails redirects here with ?token=…, or ?error=INVALID_TOKEN if it
  // has expired or been used.
  if (!token || error) {
    return (
      <AuthShell title="That link does not work" lead="It has expired, or it has been used already." footer={<a href="/sign-in">Back to sign in</a>}>
        <a href="/forgot-password">Ask for a new link</a>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password">
      <ResetPasswordForm token={token} minLength={config.passwordMinLength} />
    </AuthShell>
  );
}
