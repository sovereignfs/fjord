import { createTransport } from "nodemailer";
import type { SmtpConfig } from "../auth/config";

/**
 * Sending email: a verification link, a password reset. A small interface so the auth code
 * does not know about SMTP, and a test can read what was sent without a mail server.
 */
export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export function createSmtpMailer(config: SmtpConfig): Mailer {
  const transport = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.user ? { auth: { user: config.user, pass: config.password ?? "" } } : {}),
    // Without a timeout a mail server that does not answer holds a request open until the
    // platform gives up; a sign-up should fail fast and say so.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    async send({ to, subject, text, html }) {
      await transport.sendMail({ from: config.from, to, subject, text, html });
    },
  };
}

/** Keeps what it is given, for tests. */
export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = [];

  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
  }

  /** The most recent mail to an address. */
  last(to: string): Mail | undefined {
    return [...this.sent].reverse().find((mail) => mail.to === to);
  }

  /** The first link in the most recent mail to an address. */
  linkTo(to: string): string | undefined {
    return this.last(to)?.text.match(/https?:\/\/\S+/)?.[0];
  }
}
