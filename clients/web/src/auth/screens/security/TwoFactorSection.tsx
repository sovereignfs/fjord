"use client";

import { QRCodeSVG } from "qrcode.react";
import { type FormEvent, useState } from "react";
import { authClient } from "../../client";
import { messageFor } from "../../messages";
import { Alert, Button, FormField, Input } from "../../../ui";
import styles from "../screens.module.css";

type Step =
  | { name: "idle" }
  | { name: "password"; then: "enable" | "disable" | "codes" }
  | { name: "scan"; uri: string; codes: string[] }
  | { name: "codes"; codes: string[]; heading: string };

/** The secret in an otpauth:// URI, for someone who cannot scan the code. */
function secretOf(uri: string): string {
  return new URL(uri).searchParams.get("secret") ?? "";
}

/** Turn two-factor on and off, and see the backup codes. Each change asks for the password again. */
export function TwoFactorSection({ enabled: initiallyEnabled }: { enabled: boolean }) {
  const [enabled, setEnabled] = useState(initiallyEnabled);
  const [step, setStep] = useState<Step>({ name: "idle" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fail = (failure: Parameters<typeof messageFor>[0]) => {
    setBusy(false);
    setError(messageFor(failure));
  };

  async function onPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step.name !== "password") return;
    setBusy(true);
    setError(null);
    if (step.then === "enable") {
      const { data, error: failure } = await authClient.twoFactor.enable({ password });
      // The reply says which method it set up; an authenticator app is what was asked for.
      if (failure || data?.method !== "totp") return fail(failure);
      setPassword("");
      setBusy(false);
      setStep({ name: "scan", uri: data.totpURI, codes: data.backupCodes });
    } else if (step.then === "disable") {
      const { error: failure } = await authClient.twoFactor.disable({ password });
      if (failure) return fail(failure);
      setPassword("");
      setBusy(false);
      setEnabled(false);
      setStep({ name: "idle" });
    } else {
      const { data, error: failure } = await authClient.twoFactor.generateBackupCodes({ password });
      if (failure || !data) return fail(failure);
      setPassword("");
      setBusy(false);
      setStep({ name: "codes", codes: data.backupCodes, heading: "Your new backup codes" });
    }
  }

  async function onVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step.name !== "scan") return;
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, "") });
    if (failure) return fail(failure);
    setCode("");
    setBusy(false);
    setEnabled(true);
    setStep({ name: "codes", codes: step.codes, heading: "Two-factor is on. Keep your backup codes" });
  }

  return (
    <section className={styles.section} aria-labelledby="twofactor-title">
      <h2 id="twofactor-title">Two-factor authentication</h2>
      <p>
        {enabled
          ? "On. Signing in asks for a code from your authenticator app after your password."
          : "Off. Turn it on and signing in also needs a code from an authenticator app, so a stolen password is not enough."}
      </p>

      {error ? (
        <div className={styles.notice}>
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}

      {step.name === "idle" ? (
        <div className={styles.actions}>
          {enabled ? (
            <>
              <Button variant="secondary" onClick={() => setStep({ name: "password", then: "codes" })}>
                Get new backup codes
              </Button>
              <Button variant="secondary" onClick={() => setStep({ name: "password", then: "disable" })}>
                Turn off
              </Button>
            </>
          ) : (
            <Button onClick={() => setStep({ name: "password", then: "enable" })}>Turn on</Button>
          )}
        </div>
      ) : null}

      {step.name === "password" ? (
        <form className={styles.form} onSubmit={onPassword} style={{ marginTop: 0 }}>
          <FormField label="Confirm your password" required>
            {(field) => <Input {...field} type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />}
          </FormField>
          <div className={styles.actions}>
            <Button type="submit" loading={busy}>
              Continue
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setStep({ name: "idle" });
                setPassword("");
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {step.name === "scan" ? (
        <div className={styles.stack}>
          <p style={{ margin: 0 }}>Scan this with an authenticator app (1Password, Aegis, Google Authenticator and others), then enter the code it shows.</p>
          <div className={styles.qr}>
            <div className={styles.qrBox}>
              <QRCodeSVG value={step.uri} size={168} bgColor="#ffffff" fgColor="#000000" title="Authenticator setup code" />
            </div>
            <div className={styles.secret}>
              <p style={{ margin: "0 0 var(--sv-space-1)" }}>Or enter this key by hand:</p>
              <code className={styles.code}>{secretOf(step.uri)}</code>
            </div>
          </div>
          <form className={styles.form} onSubmit={onVerify} style={{ marginTop: 0 }}>
            <FormField label="Code from the app" hint="Two-factor is on only once a code works." required className={styles.codeInput}>
              {(field) => <Input {...field} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} disabled={busy} />}
            </FormField>
            <div className={styles.actions}>
              <Button type="submit" loading={busy}>
                Turn on
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setStep({ name: "idle" });
                  setCode("");
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </div>
      ) : null}

      {step.name === "codes" ? (
        <div className={styles.stack}>
          <Alert variant="info" heading={step.heading}>
            Each works once, if you lose your authenticator app. They are shown only now: save them somewhere safe, such as a password manager.
          </Alert>
          <ul className={styles.codes} aria-label="Backup codes">
            {step.codes.map((backup) => (
              <li key={backup}>
                <code className={styles.code}>{backup}</code>
              </li>
            ))}
          </ul>
          <div className={styles.actions}>
            <Button variant="secondary" onClick={() => navigator.clipboard?.writeText(step.codes.join("\n"))}>
              Copy
            </Button>
            <Button onClick={() => setStep({ name: "idle" })}>I have saved them</Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
