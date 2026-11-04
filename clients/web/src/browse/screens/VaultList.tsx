import type { ReactNode } from "react";
import { Alert } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import type { ClassifiedFile, VaultListing } from "../../format/types";
import { repositoryHref } from "../links";
import { vaultAddress } from "../addresses";
import type { RepositoryRead } from "../repository";
import { FILE_ICON } from "../file-icons";
import { ChooseVaultButton } from "./ChooseVaultButton";
import { Listing } from "./Listing";

/**
 * The vaults of a repository, drawn as the folders they are (the owner's request after workstream 0003): a folder for a plaintext vault and a locked one for an encrypted vault,
 * as rows or as tiles, each saying from names alone what is in it. Opening one shows what is inside, one level down. Nothing is downloaded to draw it.
 */
export function VaultList({ read, connectionId, repo, opensOn, actions }: { read: RepositoryRead; connectionId: number; /** The buttons above the listing, at its left: what makes a new vault. */ actions?: ReactNode; /** What the repository is called in an address. */ repo: string; /** The directory of the vault the repository opens on. */ opensOn?: string | undefined }) {
  const { discovery, partial, manifest } = read;
  return (
    <>
      {manifest === null ? (
        <div className={styles.notice}>
          <Alert variant="info">This repository has no <code>fjord.json</code>. Its vaults are found from the files themselves.</Alert>
        </div>
      ) : manifest.ok ? null : (
        <div className={styles.notice}>
          <Alert variant="warning">This repository's <code>fjord.json</code> cannot be read, so it may not be a Fjord repository: {manifest.error}</Alert>
        </div>
      )}
      {discovery.nested.length > 0 ? (
        <div className={styles.notice}>
          <Alert variant="warning">Vaults inside other folders are not supported in this version of the format, so these are not shown: {discovery.nested.join(", ")}.</Alert>
        </div>
      ) : null}
      {discovery.vaults.length === 0 ? (
        <>
          {actions ? <div style={{ marginBottom: "var(--sv-space-4)" }}>{actions}</div> : null}
          <p>This repository has no vaults yet: no folder in it holds a <code>fjord.vault.json</code>.</p>
        </>
      ) : (
        <Listing
          label="Vaults"
          actions={actions}
          items={discovery.vaults.map((vault) => ({
            key: vault.directory,
            name: vault.name ?? vault.directory,
            href: vault.id === null ? repositoryHref(repo, vault.directory) : vaultAddress(repo, vault.id),
            icon: vault.encrypted ? FILE_ICON.encryptedVault : FILE_ICON.vault,
            badges: [...(vault.directory === opensOn ? ["Opens first"] : []), ...(vault.encrypted ? ["Encrypted"] : [])],
            meta: [vault.name !== null && vault.name !== vault.directory ? vault.directory : "", summary(vault, partial)].filter(Boolean).join(" · "),
            trailing: discovery.vaults.length > 1 && vault.directory !== opensOn ? <ChooseVaultButton connectionId={connectionId} vault={vault.directory} label={vault.name ?? vault.directory} /> : undefined,
          }))}
        />
      )}
    </>
  );
}

function count(files: ClassifiedFile[], ...kinds: ClassifiedFile["kind"][]) {
  return files.filter((file) => kinds.includes(file.kind)).length;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function summary(vault: VaultListing, partial: boolean): string {
  if (vault.manifestError !== null) return "its manifest cannot be read";
  if (partial) return "too large to list at once";
  if (vault.encrypted) {
    const locked = count(vault.files, "payload");
    const stray = count(vault.files, "stray");
    return [plural(locked, "encrypted file", "encrypted files"), stray > 0 ? `${plural(stray, "plaintext file", "plaintext files")} that should not be there` : ""].filter(Boolean).join(", ");
  }
  const documents = count(vault.files, "doc");
  const others = count(vault.files, "other", "misplacedPayload");
  if (documents + others === 0) return "empty";
  return [plural(documents, "document", "documents"), plural(others, "other file", "other files")].join(", ");
}
