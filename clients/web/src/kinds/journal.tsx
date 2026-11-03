import { recipientsFor } from "../encrypted/server";
import { journalVault } from "../journal/entries";
import { NewEntry } from "../journal/screens/NewEntry";
import { EncryptedTimeline } from "../journal/screens/EncryptedTimeline";
import { Timeline } from "../journal/screens/Timeline";
import { Alert } from "../ui";
import styles from "../auth/screens/screens.module.css";
import type { EntryViewProps, KindModule } from "./types";

/**
 * A journal (spec §3.1): one vault of dated entries, presented as the journal itself and never as a list of one vault. Its entry view is
 * the action to write today's entry, above the timeline of every entry, newest first (ROADMAP 3b.1, 3b.2): arranged on the server for a plaintext
 * journal, and in the browser, from what it decrypts, for an encrypted one.
 */
export const journalKind: KindModule = {
  id: "journal",
  label: "Journal",
  editor: "note",
  writingView: true,
  EntryView: JournalEntry,
  contentModel: { placement: "dated", fields: ["title", "date", "tags"] },
  actions: [{ id: "new-entry", label: "New entry" }],
};

async function JournalEntry({ accountId, connection, read, query }: EntryViewProps) {
  const vaults = read.discovery.vaults;
  const vault = vaults.length === 1 ? vaults[0] : undefined;
  if (!vault) {
    return (
      <Alert variant="warning" heading="This journal does not have exactly one vault">
        A journal keeps its entries in one vault, and this repository has {vaults.length}. Show its files to see them, or change its kind.
      </Alert>
    );
  }
  const writable = journalVault(vaults);
  const encrypted = writable === "encrypted" ? await recipientsFor(accountId, connection, read, vault.directory) : undefined;
  return (
    <section aria-labelledby="journal-title">
      <h2 id="journal-title" className={styles.title}>
        {read.manifest?.ok && read.manifest.name ? read.manifest.name : "Journal"}
      </h2>
      {writable === "unsupported" ? (
        <Alert variant="info">This journal's vault cannot be written to from here: its manifest cannot be read, or its files are not named plainly.</Alert>
      ) : (
        <NewEntry connectionId={connection.id} vault={vault.directory} encrypted={encrypted} />
      )}
      {vault.encrypted === true ? (
        <EncryptedTimeline connectionId={connection.id} files={vault.files.filter((file) => file.kind === "payload").map((file) => ({ path: file.path }))} />
      ) : writable === "unsupported" ? null : read.partial ? (
        <Alert variant="info">This journal is too large to list at once, so its timeline cannot be shown here. Show its files to browse it.</Alert>
      ) : (
        <Timeline accountId={accountId} connection={connection} read={read} vault={vault} query={query} docBase="n" />
      )}
    </section>
  );
}
