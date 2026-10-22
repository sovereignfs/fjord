import type { IconName } from "@sovereignfs/ui";

/**
 * What the landing page says. It describes the product as designed (DESIGN.md §1, §3)
 * and says plainly, in the notice at the top, that it is still being built: a claim
 * here is not a claim that it works today. The things that come later say so.
 */

export interface Principle {
  id: string;
  icon: IconName;
  title: string;
  body: string;
  /** Not available yet; said on the card. */
  later?: boolean;
}

export const principles: Principle[] = [
  {
    id: "plain-files",
    icon: "file-text",
    title: "The files stay plain",
    body: "A document is a Markdown file in your repository. GitHub renders it, Obsidian opens it and git diff reads it. Stop using Fjord and you lose nothing.",
  },
  {
    id: "git-storage",
    icon: "database",
    title: "Git is the storage",
    body: "Your repository is the one true copy. Fjord keeps only what is about your files: accounts, shares, comments and drafts not yet saved. Every saved version is a commit.",
  },
  {
    id: "encryption",
    icon: "lock",
    title: "Encrypted means private",
    body: "Optional end-to-end encryption with age. Encrypted files are decrypted in your browser, and the server never holds your key.",
    later: true,
  },
];

export interface Feature {
  id: string;
  icon: IconName;
  title: string;
  body: string;
}

export const features: Feature[] = [
  {
    id: "write",
    icon: "pencil",
    title: "Write in the browser",
    body: "A document editor with the formatting Markdown can hold, and a plain editor for notes. Nothing that would quietly vanish when you save.",
  },
  {
    id: "versions",
    icon: "history",
    title: "A history you already have",
    body: "Saving makes a commit in your repository, credited to whoever made it. Roll back with git, or from Fjord.",
  },
  {
    id: "share",
    icon: "share-2",
    title: "Share with control",
    body: "Share with people on your instance or by link, with a password if you like, to view, comment or edit. Revoke it whenever you want.",
  },
  {
    id: "comment",
    icon: "users",
    title: "Comment together",
    body: "Select text, comment, reply and resolve, and see others' comments as they arrive.",
  },
  {
    id: "tools",
    icon: "code",
    title: "Use your own tools",
    body: "Edit the same repository from the command line, Obsidian or any editor. Fjord is one client of an open format, not a walled garden.",
  },
  {
    id: "host",
    icon: "shield",
    title: "Your repository, your host",
    body: "GitHub first, other Git hosts later. Fjord asks for the narrowest access that works, and you can revoke it from GitHub at any time.",
  },
];

export interface Step {
  id: string;
  title: string;
  body: string;
}

export const steps: Step[] = [
  { id: "sign-in", title: "Sign in", body: "Create an account, or continue with a Sovereign account if your instance offers it." },
  {
    id: "connect",
    title: "Connect a repository",
    body: "Install the GitHub App on the repositories you choose, or give Fjord one repository and a fine-grained token.",
  },
  { id: "write", title: "Write and share", body: "Open or create documents and notes, and share the ones you want others to see." },
];

export interface Question {
  id: string;
  question: string;
  answer: string;
}

export const questions: Question[] = [
  {
    id: "where",
    question: "Where are my documents stored?",
    answer:
      "In your Git repository, on GitHub. Fjord Web keeps accounts, connections, shares and comments in its own database, and holds a draft until it is saved as a commit.",
  },
  {
    id: "read",
    question: "Can the server read my documents?",
    answer:
      "Plaintext files, yes: it has to, to edit and share them. Encrypted files are different: they are decrypted in your browser, and the server never sees them or your key. Encrypted files arrive after the first release.",
  },
  {
    id: "leave",
    question: "What if Fjord goes away?",
    answer:
      "You keep your repository, and it is plain Markdown. There is nothing to export. The format is an open specification, and the command-line tool reads it too.",
  },
  {
    id: "hosts",
    question: "Which Git hosts work?",
    answer: "GitHub first, through a GitHub App or a fine-grained access token. Other hosts, such as GitLab and Forgejo, come later.",
  },
  {
    id: "open",
    question: "Is it open source?",
    answer:
      "Yes. Fjord Web is AGPL-3.0-or-later, the format specification is public domain (CC0), and the command-line tool and libraries are MPL-2.0. You can run your own instance.",
  },
];

/** What a Fjord document looks like on disk: the point of "plain files". */
export const exampleDocument = {
  path: "Plans/Q4 plan.fj.md",
  source: `---
id: 01k8d3m2x7q9r5t1v4w6y8z0ab
title: Q4 plan
created: 2026-10-22T09:12:04Z
---

# Q4 plan

Three things matter this quarter:

1. Ship the **editor**.
2. Move the notes into one repository.
3. Say no to the rest.
`,
};
