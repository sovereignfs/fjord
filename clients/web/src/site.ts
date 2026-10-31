/** Facts about the product that more than one place states. */
export const site = {
  name: "Fjord",
  tagline: "Documents and notes you own.",
  /** The page title: the name, then what it is, in lower case after the colon. */
  title: "Fjord: documents and notes you own",
  description:
    "Write, share and comment on documents in your browser. Every file is plain Markdown in a Git repository you control, readable without Fjord, with optional end-to-end encryption.",
  repository: "https://github.com/sovereignfs/fjord",
  specification: "https://github.com/sovereignfs/fjord/blob/main/docs/specs/Fjord.spec.md",
  licence: "AGPL-3.0-or-later",
} as const;

/** Where the landing page sends a visitor. The pages themselves arrive with ROADMAP 1a.2. */
export const routes = {
  signIn: "/sign-in",
  signUp: "/sign-up",
} as const;
