import type { Mail } from "./mailer";

/** Escape text for an HTML email: a name or a URL is data, not markup. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function layout(product: string, heading: string, lines: string[], url: string, action: string): Pick<Mail, "text" | "html"> {
  const text = `${heading}\n\n${lines.join("\n\n")}\n\n${action}: ${url}\n\n(${product})`;
  const paragraphs = lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#171717"><h1 style="font-size:1.25rem">${escapeHtml(heading)}</h1>${paragraphs}<p><a href="${escapeHtml(url)}">${escapeHtml(action)}</a></p><p style="color:#737373;font-size:0.875rem">If the button does not work, copy this address into your browser:<br>${escapeHtml(url)}</p><p style="color:#737373;font-size:0.875rem">${escapeHtml(product)}</p></body></html>`;
  return { text, html };
}

export function verificationEmail(to: string, product: string, url: string): Mail {
  return {
    to,
    subject: `Verify your email address for ${product}`,
    ...layout(
      product,
      "Verify your email address",
      [`Confirm that this is your address to finish creating your ${product} account.`, "The link works for one hour. If you did not create an account, ignore this email."],
      url,
      "Verify my email address",
    ),
  };
}

export function passwordResetEmail(to: string, product: string, url: string): Mail {
  return {
    to,
    subject: `Reset your ${product} password`,
    ...layout(
      product,
      "Reset your password",
      ["Someone asked to reset the password for this account.", "The link works for one hour. If it was not you, ignore this email: your password has not changed."],
      url,
      "Choose a new password",
    ),
  };
}
