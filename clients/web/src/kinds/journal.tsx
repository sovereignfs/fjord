import { Landing } from "../browse/screens/Landing";
import { recipientsFor } from "../encrypted/server";
import { journalVault } from "../journal/entries";
import { NewEntry } from "../journal/screens/NewEntry";
import { Alert } from "../ui";
import styles from "../auth/screens/screens.module.css";
import type { EntryViewProps, KindModule } from "./types";

/**
 * A journal (spec §3.1): one vault of dated entries, presented as the journal itself and never as a list of one vault. Its entry view is
 * the action to write today's entry, above the entries (ROADMAP 3b.1; the timeline is 3b.2).
 */
export const journalKind: KindModule = {
  id: "journal",
  label: "Journal",
  EntryView: JournalEntry,
  contentModel: { placement: "dated", fields: ["title", "date", "tags"] },
  actions: [{ id: "new-entry", label: "New entry" }],
};

async function JournalEntry({ accountId, connection, read }: EntryViewProps) {
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
      <Landing accountId={accountId} connection={connection} outcome={{ ok: true, read }} />
    </section>
  );
}
