import { notFound, redirect } from "next/navigation";
import { oauthErrorMessage } from "../../src/auth/messages";
import { AuthShell } from "../../src/auth/screens/AuthShell";
import { SignInForm } from "../../src/auth/screens/SignInForm";
import { safeNext } from "../../src/auth/next";
import { authConfig, getSession, localAuthConfig, signUpAvailable, sovereignAuthConfig } from "../../src/auth/server";

// Decided per request from the instance's settings and the visitor's cookies. Left to Next it
// would be prerendered at build time, with no settings, as the "off" 404 it would then keep.
export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ reset?: string; error?: string; next?: string | string[] }> }) {
  const instance = authConfig();
  if (!instance.enabled) notFound();
  const { reset, error, next: wanted } = await searchParams;
  const next = safeNext(typeof wanted === "string" ? wanted : null);
  if (await getSession()) redirect(next ?? "/");
  const local = localAuthConfig();

  return (
    <AuthShell title={`Sign in to ${instance.name}`} name={instance.name}>
      <SignInForm
        {...(local ? { local: { canReset: local.smtp !== undefined, canSignUp: await signUpAvailable() } } : {})}
        sovereign={sovereignAuthConfig() !== undefined}
        instanceName={instance.name}
        next={next}
        {...(reset === "1" && local ? { notice: "Your password is changed. Sign in with the new one." } : {})}
        {...(oauthErrorMessage(error) ? { initialError: oauthErrorMessage(error) as string } : {})}
      />
    </AuthShell>
  );
}
