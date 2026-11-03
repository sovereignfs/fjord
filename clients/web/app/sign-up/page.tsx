import { notFound, redirect } from "next/navigation";
import { AuthShell } from "../../src/auth/screens/AuthShell";
import { SignUpForm } from "../../src/auth/screens/SignUpForm";
import { AuthLink } from "../../src/ui";
import { getSession, localAuthConfig, signUpAvailable } from "../../src/auth/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Create an account" };

export default async function SignUpPage() {
  const config = localAuthConfig();
  if (!config) notFound();
  if (await getSession()) redirect("/");

  if (!(await signUpAvailable())) {
    return (
      <AuthShell title="Sign-up is closed" name={config.name} lead={`${config.name} is not taking new accounts. If you have one, sign in; otherwise ask whoever runs this instance.`}>
        <AuthLink href="/sign-in">Go to sign in</AuthLink>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create your account"
      name={config.name}
      footer={
        <>
          Already have an account? <AuthLink href="/sign-in">Sign in</AuthLink>
        </>
      }
    >
      <SignUpForm minLength={config.passwordMinLength} verifyEmail={config.requireEmailVerification} />
    </AuthShell>
  );
}
