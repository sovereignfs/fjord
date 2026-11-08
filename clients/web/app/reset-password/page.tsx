import { notFound } from 'next/navigation';
import { AuthShell } from '../../src/auth/screens/AuthShell';
import { ResetPasswordForm } from '../../src/auth/screens/ResetForms';
import { AuthLink } from '../../src/ui';
import { localAuthConfig } from '../../src/auth/server';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Choose a new password' };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const config = localAuthConfig();
  if (!config?.smtp) notFound();
  const { token, error } = await searchParams;

  // The link better-auth emails redirects here with ?token=…, or ?error=INVALID_TOKEN if it
  // has expired or been used.
  if (!token || error) {
    return (
      <AuthShell
        title="Invalid link"
        name={config.name}
        lead="It has expired, or it has been used already."
        footer={
          <>
            <AuthLink href="/forgot-password">Ask for a new link</AuthLink>
            <br />
            <AuthLink href="/sign-in">Back to sign in</AuthLink>
          </>
        }
        footerAlign="start"
      />
    );
  }

  return (
    <AuthShell
      title="Choose a new password"
      name={config.name}
      footer={<AuthLink href="/sign-in">Back to sign in</AuthLink>}
    >
      <ResetPasswordForm token={token} minLength={config.passwordMinLength} />
    </AuthShell>
  );
}
