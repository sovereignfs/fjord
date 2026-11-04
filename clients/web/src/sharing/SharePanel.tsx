"use client";

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { ROLES, type Role } from "../access/policy";
import { Alert, Avatar, Badge, Button, FormField, Input, Select, Tabs } from "../ui";
import styles from "./Sharing.module.css";
import {
  type LinkEntry,
  type SharedWith,
  addShare,
  fromLocalInput,
  listLinks,
  listShares,
  removeShare,
  revokeLink,
  toLocalInput,
  updateLink,
} from "./manage-client";

/**
 * Who a document is shared with, and how it is published (DESIGN.md §12, ROADMAP 1c.7), in the sharing dialog: **People** (accounts on this instance, added by their address, each given a role: view, comment or
 * edit, and changed or removed) and **Publish** (`publish`: the page anyone can read, with an optional password). Sharing is within this instance (later, between Fjord instances); the file stays its owner's,
 * and what someone with the edit role changes is kept as a draft for the owner to review and save (`working/`). **Links are not made any more**: a link someone made before is still shown, in a *Links* tab that
 * is there only while the document has one, to be changed or revoked, which is the owner's way to end it.
 */
const ROLE_WORDS: Record<Role, string> = { view: "Can view", comment: "Can comment", edit: "Can edit" };
type Tab = "people" | "links" | "publish";

export function SharePanel({ connectionId, docId, publish, justIdentified = false }: { connectionId: number; docId: string; /** The panel that publishes the document as a page, which is the third tab. */ publish: ReactNode; /** The file was given its identifier a moment ago, in this dialog: it says so. */ justIdentified?: boolean }) {
  const [tab, setTab] = useState<Tab>("people");
  const [loaded, setLoaded] = useState(false);
  const [people, setPeople] = useState<SharedWith[]>([]);
  const [links, setLinks] = useState<LinkEntry[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [shared, linked] = await Promise.all([listShares(connectionId, docId), listLinks(connectionId, docId)]);
    if (shared.ok) setPeople(shared.shares);
    if (linked.ok) setLinks(linked.links);
    setProblem(!shared.ok ? shared.message : !linked.ok ? linked.message : null);
    setLoaded(true);
  }, [connectionId, docId]);

  // It is shown in a dialog (`ShareDialog`), which opens it: what it says is read as it opens.
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const active = links.filter((link) => link.status === "active").length;
  return (
    <div className={styles.root}>
      {justIdentified ? (
        <Alert variant="success" heading="The file has an identifier">
          It can be shared now.
        </Alert>
      ) : null}
      <Tabs
        aria-label="Ways to share"
        value={tab}
        onChange={(next) => setTab(next as Tab)}
        items={[
          { label: people.length > 0 ? `People (${people.length})` : "People", value: "people" },
          ...(links.length > 0 ? [{ label: active > 0 ? `Links (${active})` : "Links", value: "links" }] : []),
          { label: "Publish", value: "publish" },
        ]}
      />
      {problem ? (
        <Alert variant="error" heading="Sharing">
          {problem}
        </Alert>
      ) : null}
      <div className={styles.panel} role="tabpanel" aria-label={tab === "people" ? "People" : tab === "links" ? "Links" : "Publish"}>
        {tab === "people" ? <People connectionId={connectionId} docId={docId} people={people} changed={load} /> : null}
        {tab === "links" ? <Links connectionId={connectionId} docId={docId} links={links} changed={load} /> : null}
        {tab === "publish" ? publish : null}
      </div>
    </div>
  );
}

function RoleSelect({ value, onChange, label, disabled, field, size = "md" }: { size?: "sm" | "md"; value: Role; onChange: (role: Role) => void; label: string; disabled?: boolean; /** What a `FormField` hands its control. */ field?: { id?: string; "aria-describedby"?: string | undefined } }) {
  return (
    <Select {...field} size={size} aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as Role)}>
      {ROLES.map((role) => (
        <option key={role} value={role}>
          {ROLE_WORDS[role]}
        </option>
      ))}
    </Select>
  );
}

function People({ connectionId, docId, people, changed }: { connectionId: number; docId: string; people: SharedWith[]; changed: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("view");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; message: string } | null>(null);

  async function share() {
    setBusy(true);
    setSaid(null);
    const done = await addShare(connectionId, docId, email, role);
    setBusy(false);
    setSaid({ ok: done.ok, message: done.message });
    if (done.ok) {
      setEmail("");
      await changed();
    }
  }

  async function change(person: SharedWith, next: Role) {
    setSaid(null);
    // Sharing again with the same address changes the role.
    const done = await addShare(connectionId, docId, person.email, next);
    if (!done.ok) setSaid({ ok: false, message: done.message });
    await changed();
  }

  async function remove(person: SharedWith) {
    setSaid(null);
    const done = await removeShare(connectionId, docId, person.accountId);
    if (!done.ok) setSaid({ ok: false, message: done.message });
    await changed();
  }

  return (
    <>
      <form
        className={styles.invite}
        onSubmit={(event) => {
          event.preventDefault();
          void share();
        }}
      >
        <FormField label="Share with">
          {(field) => <Input {...field} type="email" name="email" autoComplete="off" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />}
        </FormField>
        <RoleSelect value={role} label="Role for the new person" onChange={setRole} disabled={busy} />
        <Button type="submit" loading={busy} disabled={email.trim() === ""}>
          Share
        </Button>
      </form>
      <p className={styles.muted}>Use the email address of their account here. Only people who already have an account can be shared with.</p>
      {said ? (
        <Alert variant={said.ok ? "info" : "error"} heading={said.ok ? "Done" : "Not shared"}>
          {said.message}
        </Alert>
      ) : null}
      {people.length === 0 ? <p className={styles.empty}>Not shared with anyone.</p> : <h3 className={styles.heading}>Who has access</h3>}
      <ul aria-label="People with access" className={styles.list}>
        {people.map((person) => (
          <li key={person.accountId} className={styles.person}>
            <Avatar name={person.name} size="sm" />
            <span className={styles.who}>
              <span className={styles.name}>{person.name}</span>
              <span className={styles.email}>{person.email}</span>
            </span>
            <RoleSelect size="sm" value={person.role} label={`Role of ${person.name}`} onChange={(next) => void change(person, next)} />
            <button type="button" className={styles.remove} aria-label={`Stop sharing with ${person.name}`} onClick={() => void remove(person)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** The links made before links were retired: each with its state, to be changed or revoked. Nothing here makes one. */
function Links({ connectionId, docId, links, changed }: { connectionId: number; docId: string; links: LinkEntry[]; changed: () => Promise<void> }) {
  return (
    <>
      <p className={styles.muted}>Links are not made any more: share with people who have an account here, or publish a page. These were made before, and still open the document until they are revoked or expire.</p>
      <ul aria-label="Links to this document" className={styles.list} style={{ gap: 0 }}>
        {links.map((link) => (
          <LinkRow key={link.id} connectionId={connectionId} docId={docId} link={link} changed={changed} />
        ))}
      </ul>
    </>
  );
}

function LinkRow({ connectionId, docId, link, changed }: { connectionId: number; docId: string; link: LinkEntry; changed: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [role, setRole] = useState<Role>(link.role);
  const [expires, setExpires] = useState(toLocalInput(link.expiresAt));
  const [password, setPassword] = useState("");
  const [removePassword, setRemovePassword] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const expiresAt = fromLocalInput(expires);
    if (expiresAt === undefined) return setError("That is not a date and time.");
    setBusy(true);
    setError(null);
    const done = await updateLink(connectionId, docId, link.id, {
      ...(role === link.role ? {} : { role }),
      ...(expiresAt === link.expiresAt ? {} : { expiresAt }),
      ...(removePassword ? { password: null } : password !== "" ? { password } : {}),
    });
    setBusy(false);
    if (!done.ok) return setError(done.message);
    setEditing(false);
    setPassword("");
    setRemovePassword(false);
    await changed();
  }

  async function revoke() {
    setBusy(true);
    const done = await revokeLink(connectionId, docId, link.id);
    setBusy(false);
    if (!done.ok) return setError(done.message);
    setConfirming(false);
    await changed();
  }

  return (
    <li className={styles.link} data-testid="link-row" data-status={link.status}>
      <span className={styles.linkMain}>
        <span className={styles.linkHead}>
          {ROLE_WORDS[link.role]}
          <Badge>{link.status === "active" ? "Active" : link.status === "expired" ? "Expired" : "Revoked"}</Badge>
          {link.passwordProtected ? <Badge>Password</Badge> : null}
        </span>
        <span className={styles.email}>
          {link.status === "revoked" ? "Revoked" : link.expiresAt === null ? "Does not expire" : `${link.status === "expired" ? "Expired" : "Expires"} ${new Date(link.expiresAt).toLocaleString()}`}
        </span>
      </span>
      {link.status === "revoked" ? null : (
        <span className={styles.linkActions}>
          <Button variant="secondary" size="sm" onClick={() => setEditing(!editing)} aria-expanded={editing}>
            {editing ? "Cancel" : "Change"}
          </Button>
          {confirming ? (
            <>
              <Button variant="destructive" size="sm" onClick={() => void revoke()} loading={busy}>
                Yes, revoke
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
                Keep
              </Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
              Revoke
            </Button>
          )}
        </span>
      )}
      {editing ? (
        <form
          className={`${styles.form} ${styles.linkForm}`}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className={styles.fields}>
            <FormField label="What it allows">{(field) => <RoleSelect field={field} value={role} label="What the link allows" onChange={setRole} disabled={busy} />}</FormField>
            <FormField label="Expires" hint="Empty for a link that does not expire. A later time revives a link that has expired.">
              {(field) => <Input {...field} type="datetime-local" name="expires" value={expires} onChange={(e) => setExpires(e.target.value)} disabled={busy} />}
            </FormField>
            <FormField label={link.passwordProtected ? "New password" : "Password"} hint={link.passwordProtected ? "Leave empty to keep the password it has. A new one ends what the old one opened." : "Optional. Eight characters or more."}>
              {(field) => <Input {...field} type="password" name="new-password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy || removePassword} />}
            </FormField>
          </div>
          {link.passwordProtected ? (
            <label className={styles.checkbox}>
              <input type="checkbox" checked={removePassword} onChange={(e) => setRemovePassword(e.target.checked)} disabled={busy} /> Remove the password
            </label>
          ) : null}
          <div className={styles.actions}>
            <Button type="submit" size="sm" loading={busy}>
              Save
            </Button>
          </div>
        </form>
      ) : null}
      {error ? (
        <div className={styles.linkForm}>
          <Alert variant="error" heading="Not changed">
            {error}
          </Alert>
        </div>
      ) : null}
    </li>
  );
}
