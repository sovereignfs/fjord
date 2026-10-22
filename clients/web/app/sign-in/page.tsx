import { notFound, redirect } from "next/navigation";
import { AuthShell } from "../../src/auth/screens/AuthShell";
import { SignInForm } from "../../src/auth/screens/SignInForm";
import { getSession, localAuthConfig, signUpAvailable } from "../../src/auth/server";

// Decided per request from the instance's settings and the visitor's cookies. Left to Next it
// would be prerendered at build time, with no settings, as the "off" 404 it would then keep.
export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ reset?: string }> }) {
  const config = localAuthConfig();
  if (!config) notFound();
  if (await getSession()) redirect("/");
  const { reset } = await searchParams;

  return (
    <AuthShell title="Sign in" lead={`Welcome back to ${config.name}.`}>
      <SignInForm
        canReset={config.smtp !== undefined}
        canSignUp={await signUpAvailable()}
        {...(reset === "1" ? { notice: "Your password is changed. Sign in with the new one." } : {})}
      />
    </AuthShell>
  );
}
