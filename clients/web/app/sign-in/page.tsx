import { notFound, redirect } from "next/navigation";
import { oauthErrorMessage } from "../../src/auth/messages";
import { AuthShell } from "../../src/auth/screens/AuthShell";
import { SignInForm } from "../../src/auth/screens/SignInForm";
import { authConfig, getSession, localAuthConfig, signUpAvailable, sovereignAuthConfig } from "../../src/auth/server";

// Decided per request from the instance's settings and the visitor's cookies. Left to Next it
// would be prerendered at build time, with no settings, as the "off" 404 it would then keep.
export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ reset?: string; error?: string }> }) {
  const instance = authConfig();
  if (!instance.enabled) notFound();
  if (await getSession()) redirect("/");
  const { reset, error } = await searchParams;
  const local = localAuthConfig();

  return (
    <AuthShell title="Sign in" lead={`Welcome back to ${instance.name}.`}>
      <SignInForm
        {...(local ? { local: { canReset: local.smtp !== undefined, canSignUp: await signUpAvailable() } } : {})}
        sovereign={sovereignAuthConfig() !== undefined}
        {...(reset === "1" && local ? { notice: "Your password is changed. Sign in with the new one." } : {})}
        {...(oauthErrorMessage(error) ? { initialError: oauthErrorMessage(error) as string } : {})}
      />
    </AuthShell>
  );
}
