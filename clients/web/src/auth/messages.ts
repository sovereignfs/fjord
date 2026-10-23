/**
 * What to tell a person when sign-in goes wrong. better-auth answers with a code and an
 * English message meant for developers; these say what the person can do. A code that is not
 * here falls back to better-auth's own message, and failing that to a plain sentence, and no
 * message ever says whether an email address has an account.
 */
const BY_CODE: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "That email address and password do not match. Check them and try again.",
  EMAIL_NOT_VERIFIED: "Confirm your email address first: we sent you a link when you signed up.",
  INVALID_PASSWORD: "That password is not right.",
  PASSWORD_TOO_SHORT: "That password is too short.",
  PASSWORD_TOO_LONG: "That password is too long.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "There is already an account with that email address. Try signing in instead.",
  INVALID_CODE: "That code is not right. Check it and try again.",
  INVALID_BACKUP_CODE: "That backup code is not right, or it has been used already.",
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: "Too many wrong codes. Sign in again to get another try.",
  INVALID_TWO_FACTOR_COOKIE: "Your sign-in took too long or has been used up. Start again.",
  INVALID_TOKEN: "That link has expired or has already been used. Ask for a new one.",
  SIGNUP_CLOSED: "Sign-up is closed on this instance.",
  RESET_PASSWORD_DISABLED: "Password reset by email is not set up on this instance.",
  UNAUTHORIZED: "You need to sign in first.",
};

export interface AuthError {
  code?: string | undefined;
  message?: string | undefined;
  status?: number | undefined;
}

export function messageFor(error: AuthError | null | undefined, fallback = "Something went wrong. Please try again."): string {
  if (!error) return fallback;
  if (error.status === 429) return "Too many tries. Wait a few seconds and try again.";
  if (error.code && BY_CODE[error.code]) return BY_CODE[error.code]!;
  if (error.status === 403 && /closed/i.test(error.message ?? "")) return "Sign-up is closed on this instance.";
  // A passkey ceremony cancelled by the person is not an error worth shouting about.
  if (/cancel|abort|not allowed/i.test(error.message ?? "")) return "That was cancelled.";
  return error.message && error.message.length < 140 ? error.message : fallback;
}

/**
 * The `?error=` code better-auth puts on the sign-in page when a sign-in through another service
 * (Sovereign) fails after the person has left and come back. These are not API errors, and some
 * are our own policy (a closed sign-up) and some are the service's (it refused the client), so
 * each says what the person can do and none says more about an account than they already know.
 */
const BY_OAUTH_ERROR: Record<string, string> = {
  account_not_linked:
    "There is already an account here with that email address, signed in another way. Sign in the way you did before, and link Sovereign from your account settings.",
  SIGNUP_CLOSED: "Sign-up is closed on this instance. Ask whoever runs it to let you in.",
  unable_to_create_user: "Sign-up is closed on this instance. Ask whoever runs it to let you in.",
  signup_disabled: "Sign-up is closed on this instance. Ask whoever runs it to let you in.",
  email_not_verified: "Sovereign has not confirmed your email address yet. Confirm it there and try again.",
  email_not_found: "Sovereign did not share an email address, which this instance needs.",
  access_denied: "You declined to share your Sovereign account, so you were not signed in.",
  invalid_code: "Signing in with Sovereign did not complete. Try again.",
  state_mismatch: "Your sign-in took too long or was started somewhere else. Start again.",
  please_restart_the_process: "Your sign-in took too long or was started somewhere else. Start again.",
};

/** A message for the `?error=` on the sign-in page, or null when there is none to show. */
export function oauthErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return BY_OAUTH_ERROR[code] ?? "Signing in with Sovereign did not work. Try again, or ask whoever runs this instance.";
}
