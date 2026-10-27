"use client";

import { useCallback, useState } from "react";
import { ROLES, type Role } from "../access/policy";
import { Alert, Badge, Button, FormField, Input } from "../ui";
import styles from "../auth/screens/screens.module.css";
import {
  type LinkEntry,
  type SharedWith,
  addShare,
  createLink,
  fromLocalInput,
  listLinks,
  listShares,
  removeShare,
  revokeLink,
  toLocalInput,
  updateLink,
} from "./manage-client";

/**
 * Who a document is shared with, and by which links (DESIGN.md §12, ROADMAP 1c.7): the owner sees every share of it and controls each. People
 * are added by the address of their account, given a role, changed and removed; links are made with a role, an optional expiry and an optional
 * password, changed, and revoked. A link's address is shown **once**, when it is made, because only a hash of its token is kept: to share a
 * link again, make another and revoke the old one. The lists are read when the panel is first opened.
 */
const ROLE_WORDS: Record<Role, string> = { view: "Can view", comment: "Can comment", edit: "Can edit" };

export function SharePanel({ connectionId, docId }: { connectionId: number; docId: string }) {
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

  return (
    <details
      className={styles.itemMeta}
      data-testid="share-panel"
      onToggle={(event) => {
        if ((event.currentTarget as HTMLDetailsElement).open && !loaded) void load();
      }}
    >
      <summary>Sharing</summary>
      {problem ? (
        <div className={styles.notice}>
          <Alert variant="error" heading="Sharing">
            {problem}
          </Alert>
        </div>
      ) : null}
      <People connectionId={connectionId} docId={docId} people={people} changed={load} />
      <Links connectionId={connectionId} docId={docId} links={links} changed={load} />
    </details>
  );
}

function RoleSelect({ value, onChange, label, disabled }: { value: Role; onChange: (role: Role) => void; label: string; disabled?: boolean }) {
  return (
    <select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as Role)}>
      {ROLES.map((role) => (
        <option key={role} value={role}>
          {ROLE_WORDS[role]}
        </option>
      ))}
    </select>
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
    <section aria-label="People">
      <h3>People</h3>
      {people.length === 0 ? <p>Not shared with anyone.</p> : null}
      <ul aria-label="People with access" className={styles.list}>
        {people.map((person) => (
          <li key={person.accountId} className={styles.item}>
            <span>
              {person.name} <span className={styles.itemMeta}>{person.email}</span>
            </span>
            <span>
              <RoleSelect value={person.role} label={`Role of ${person.name}`} onChange={(next) => void change(person, next)} />{" "}
              <Button variant="secondary" size="sm" onClick={() => void remove(person)}>
                Stop sharing
              </Button>
            </span>
          </li>
        ))}
      </ul>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          void share();
        }}
      >
        <FormField label="Share with" hint="The email address of their account here. Only existing accounts can be shared with.">
          {(field) => <Input {...field} type="email" name="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />}
        </FormField>
        <RoleSelect value={role} label="Role for the new person" onChange={setRole} disabled={busy} />
        <div className={styles.actions}>
          <Button type="submit" size="sm" loading={busy} disabled={email.trim() === ""}>
            Share
          </Button>
        </div>
      </form>
      {said ? (
        <div className={styles.notice}>
          <Alert variant={said.ok ? "info" : "error"} heading={said.ok ? "Done" : "Not shared"}>
            {said.message}
          </Alert>
        </div>
      ) : null}
    </section>
  );
}

function Links({ connectionId, docId, links, changed }: { connectionId: number; docId: string; links: LinkEntry[]; changed: () => Promise<void> }) {
  const [role, setRole] = useState<Role>("view");
  const [expires, setExpires] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ url: string; passwordProtected: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  async function make() {
    const expiresAt = fromLocalInput(expires);
    if (expiresAt === undefined) return setError("That is not a date and time.");
    setBusy(true);
    setError(null);
    setMade(null);
    setCopied(false);
    const done = await createLink(connectionId, docId, { role, expiresAt, password: password === "" ? null : password });
    setBusy(false);
    if (!done.ok) return setError(done.message);
    setMade({ url: done.url, passwordProtected: done.passwordProtected });
    setPassword("");
    setExpires("");
    await changed();
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError("Could not copy it. Select the address and copy it by hand.");
    }
  }

  return (
    <section aria-label="Links">
      <h3>Links</h3>
      {links.length === 0 ? <p>No links.</p> : null}
      <ul aria-label="Links to this document" className={styles.list}>
        {links.map((link) => (
          <LinkRow key={link.id} connectionId={connectionId} docId={docId} link={link} changed={changed} />
        ))}
      </ul>
      <p className={styles.itemMeta}>A link&apos;s address is shown once, when it is made. To share one again, make another and revoke the old one.</p>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          void make();
        }}
      >
        <RoleSelect value={role} label="What the new link allows" onChange={setRole} disabled={busy} />
        <FormField label="Expires" hint="Leave empty for a link that does not expire.">
          {(field) => <Input {...field} type="datetime-local" name="expires" value={expires} onChange={(e) => setExpires(e.target.value)} disabled={busy} />}
        </FormField>
        <FormField label="Password" hint="Optional. Eight characters or more; asked for when the link is opened.">
          {(field) => <Input {...field} type="password" name="link-password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />}
        </FormField>
        <div className={styles.actions}>
          <Button type="submit" size="sm" loading={busy}>
            Make a link
          </Button>
        </div>
      </form>
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error" heading="Links">
            {error}
          </Alert>
        </div>
      ) : null}
      {made ? (
        <div className={styles.notice} data-testid="new-link">
          <Alert variant="success" heading="Link made">
            {made.passwordProtected ? "It asks for the password you gave. " : ""}This is the only time its address is shown.
            <p>
              <Input aria-label="The new link's address" readOnly value={made.url} onFocus={(e) => e.currentTarget.select()} />{" "}
              <Button size="sm" onClick={() => void copy(made.url)}>
                {copied ? "Copied" : "Copy link"}
              </Button>
            </p>
          </Alert>
        </div>
      ) : null}
    </section>
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
    <li className={styles.item} data-testid="link-row" data-status={link.status}>
      <span>
        {ROLE_WORDS[link.role]}{" "}
        <Badge>{link.status === "active" ? "Active" : link.status === "expired" ? "Expired" : "Revoked"}</Badge>
        {link.passwordProtected ? (
          <>
            {" "}
            <Badge>Password</Badge>
          </>
        ) : null}{" "}
        <span className={styles.itemMeta}>
          {link.status === "revoked" ? "Revoked" : link.expiresAt === null ? "Does not expire" : `${link.status === "expired" ? "Expired" : "Expires"} ${new Date(link.expiresAt).toLocaleString()}`}
        </span>
      </span>
      {link.status === "revoked" ? null : (
        <span>
          <Button variant="secondary" size="sm" onClick={() => setEditing(!editing)} aria-expanded={editing}>
            {editing ? "Cancel" : "Change"}
          </Button>{" "}
          {confirming ? (
            <>
              <Button variant="destructive" size="sm" onClick={() => void revoke()} loading={busy}>
                Yes, revoke
              </Button>{" "}
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
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <RoleSelect value={role} label="What the link allows" onChange={setRole} disabled={busy} />
          <FormField label="Expires" hint="Empty for a link that does not expire. A later time revives a link that has expired.">
            {(field) => <Input {...field} type="datetime-local" name="expires" value={expires} onChange={(e) => setExpires(e.target.value)} disabled={busy} />}
          </FormField>
          <FormField label={link.passwordProtected ? "New password" : "Password"} hint={link.passwordProtected ? "Leave empty to keep the password it has. A new one ends what the old one opened." : "Optional. Eight characters or more."}>
            {(field) => <Input {...field} type="password" name="new-password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy || removePassword} />}
          </FormField>
          {link.passwordProtected ? (
            <label>
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
        <div className={styles.notice}>
          <Alert variant="error" heading="Not changed">
            {error}
          </Alert>
        </div>
      ) : null}
    </li>
  );
}
