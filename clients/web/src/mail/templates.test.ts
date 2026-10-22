import { describe, expect, it } from "vitest";
import { MemoryMailer } from "./mailer";
import { escapeHtml, passwordResetEmail, verificationEmail } from "./templates";

const URL_WITH_TOKEN = "https://fjord.example.com/api/auth/verify-email?token=abc&callbackURL=%2F";

describe("the emails", () => {
  it("carry the link in both the text and the HTML part", () => {
    const mail = verificationEmail("a@example.com", "Fjord", URL_WITH_TOKEN);
    expect(mail.text).toContain(URL_WITH_TOKEN);
    expect(mail.html).toContain(escapeHtml(URL_WITH_TOKEN));
    expect(mail.to).toBe("a@example.com");
    expect(mail.subject).toContain("Fjord");
  });

  it("say what to do if the reader did not ask for it", () => {
    expect(passwordResetEmail("a@example.com", "Fjord", URL_WITH_TOKEN).text).toMatch(/ignore this email/);
    expect(verificationEmail("a@example.com", "Fjord", URL_WITH_TOKEN).text).toMatch(/ignore this email/);
  });

  it("treat the instance name as data, not markup", () => {
    const mail = verificationEmail("a@example.com", `<script>alert(1)</script>`, URL_WITH_TOKEN);
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
  });

  it("escape quotes in a URL so it cannot break out of its attribute", () => {
    const mail = passwordResetEmail("a@example.com", "Fjord", `https://x.example.com/?q="onmouseover="alert(1)`);
    expect(mail.html).not.toContain('"onmouseover="');
  });
});

describe("MemoryMailer", () => {
  it("keeps what it is sent and finds the latest link for an address", async () => {
    const mailer = new MemoryMailer();
    await mailer.send(verificationEmail("a@example.com", "Fjord", "https://x.example.com/first"));
    await mailer.send(verificationEmail("a@example.com", "Fjord", "https://x.example.com/second"));
    await mailer.send(verificationEmail("b@example.com", "Fjord", "https://x.example.com/other"));
    expect(mailer.sent).toHaveLength(3);
    expect(mailer.linkTo("a@example.com")).toBe("https://x.example.com/second");
    expect(mailer.linkTo("nobody@example.com")).toBeUndefined();
  });
});
