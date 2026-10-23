import { describe, expect, it } from "vitest";
import { messageFor, oauthErrorMessage } from "./messages";

describe("messageFor", () => {
  it("never says whether an address has an account: a wrong password and a missing user read alike", () => {
    const wrong = messageFor({ code: "INVALID_EMAIL_OR_PASSWORD", status: 401 });
    expect(wrong).toMatch(/do not match/);
    expect(wrong).not.toMatch(/no account|not found|exists/i);
  });

  it("translates the codes a person can act on", () => {
    expect(messageFor({ code: "EMAIL_NOT_VERIFIED" })).toMatch(/Confirm your email/);
    expect(messageFor({ code: "INVALID_BACKUP_CODE" })).toMatch(/used already/);
    expect(messageFor({ code: "INVALID_TOKEN" })).toMatch(/expired/);
  });

  it("says to wait when the server says there have been too many requests", () => {
    expect(messageFor({ status: 429, message: "Too many requests. Please try again later." })).toMatch(/Wait a few seconds/);
  });

  it("recognises a closed sign-up", () => {
    expect(messageFor({ status: 403, message: "Sign-up is closed on this instance." })).toBe("Sign-up is closed on this instance.");
  });

  it("does not report a cancelled passkey prompt as a failure", () => {
    expect(messageFor({ message: "The operation either timed out or was not allowed" })).toBe("That was cancelled.");
  });

  it("falls back to the server's short message, then to a plain sentence", () => {
    expect(messageFor({ code: "SOMETHING_NEW", message: "Short and clear" })).toBe("Short and clear");
    expect(messageFor({ message: "x".repeat(300) })).toBe("Something went wrong. Please try again.");
    expect(messageFor(null)).toBe("Something went wrong. Please try again.");
  });
});

describe("linking Sovereign", () => {
  it("says what to do about each way a link can fail, without naming an address", () => {
    expect(oauthErrorMessage("email_does_not_match")).toMatch(/different email address/);
    expect(oauthErrorMessage("account_already_linked_to_different_user")).toMatch(/already linked to another account/);
    expect(oauthErrorMessage("account_not_linked")).toMatch(/security page/);
    for (const code of ["email_does_not_match", "account_already_linked_to_different_user", "account_not_linked", "unable_to_link_account"]) {
      expect(oauthErrorMessage(code)).not.toMatch(/@/);
    }
  });

  it("explains a refused unlink and a session that is not fresh enough", () => {
    expect(messageFor({ code: "FAILED_TO_UNLINK_LAST_ACCOUNT", status: 400 })).toMatch(/only way you can sign in/);
    expect(messageFor({ code: "SESSION_NOT_FRESH", status: 403 })).toMatch(/sign in again/);
  });

  it("has a plain sentence for a code it does not know, and nothing for no error", () => {
    expect(oauthErrorMessage("something_new")).toMatch(/Something went wrong with Sovereign/);
    expect(oauthErrorMessage(undefined)).toBeNull();
  });
});

