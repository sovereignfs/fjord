import { Alert, Button } from "../../ui";
import styles from "../../auth/screens/screens.module.css";

/**
 * Connecting repositories through the instance's GitHub App (ROADMAP 1a.6): a button that takes the person to GitHub, where they
 * install the App and choose which repositories it may reach, and what they are told when they come back. A plain form that
 * navigates, so it needs no script. The words for the way back are ours and chosen by a short code in the address: nothing in the
 * address is shown as it is.
 */
const MESSAGES: Record<string, { variant: "success" | "info" | "error"; text: string }> = {
  requested: { variant: "info", text: "Your request to install the App was sent to the organisation's owners. Once they approve it, come back here and connect again." },
  state: { variant: "error", text: "That did not start from this page, so nothing was connected. Start again with the button below." },
  incomplete: { variant: "error", text: "GitHub did not say what was installed, so nothing was connected. Start again with the button below." },
  code_rejected: { variant: "error", text: "GitHub did not accept the sign-in that proves the installation is yours, so nothing was connected. Try again." },
  not_yours: { variant: "error", text: "That installation is not one you can reach on GitHub, so nothing was connected." },
  nothing_to_connect: { variant: "info", text: "The App is installed, but on no repository that you can reach. Choose repositories for it on GitHub, then connect again." },
  rate_limited: { variant: "error", text: "GitHub is limiting requests. Try again in a moment." },
  unavailable: { variant: "error", text: "Could not reach GitHub just now. Try again in a moment." },
  not_configured: { variant: "error", text: "This instance cannot keep the connection yet. Its administrator needs to check its GitHub App and encryption key settings." },
};

const count = (value: string | undefined) => (value !== undefined && /^[0-9]{1,3}$/.test(value) ? Number(value) : 0);
const repositories = (n: number) => `${n} ${n === 1 ? "repository" : "repositories"}`;

export function GitHubAppPanel({ result }: { result: { github_app?: string | undefined; added?: string | undefined; already?: string | undefined; skipped?: string | undefined } }) {
  let message = result.github_app ? MESSAGES[result.github_app] : undefined;
  if (result.github_app === "ok") {
    const added = count(result.added);
    const already = count(result.already);
    const skipped = count(result.skipped);
    const parts = [
      added > 0 ? `Connected ${repositories(added)}.` : "Nothing new was connected.",
      already > 0 ? `${repositories(already)} already connected.` : "",
      skipped > 0 ? `${repositories(skipped)} left out because they are empty, cannot be written to, or could not be reached: check that the App has Contents: Read and write.` : "",
    ].filter(Boolean);
    message = { variant: skipped > 0 && added === 0 ? "info" : "success", text: parts.join(" ") };
  }

  return (
    <section className={styles.section} aria-labelledby="github-app-title">
      <h2 id="github-app-title">Connect with the GitHub App</h2>
      <p>Install the App on GitHub and choose the repositories it may reach. It asks for nothing else, and Fjord keeps no token: it asks GitHub for a short-lived one when it needs it.</p>
      {message ? <Alert variant={message.variant}>{message.text}</Alert> : null}
      <form method="get" action="/api/github-app/install">
        <div className={styles.actions}>
          <Button type="submit">Install on GitHub</Button>
        </div>
      </form>
    </section>
  );
}
