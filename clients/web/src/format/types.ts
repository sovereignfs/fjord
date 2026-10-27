/**
 * What `fjord-wasm` says, as TypeScript: the shapes of its JSON (`crates/fjord-wasm/src/api.rs` documents
 * each). The module is `fjord-core` compiled to WebAssembly, so these are the format's own answers and
 * nothing here re-derives them (the build brief's first rule).
 */

/** A file of a repository, as a tree listing gives it. A directory is not a file; a symbolic link is. */
export interface ListedFile {
  path: string;
  size: number;
}

/**
 * What a file in a vault is, by its name (spec §2, §6.3, §8.4): an encrypted payload; plaintext where
 * there must be none (`stray`); an encrypted file in a plaintext vault; a document (`*.fj.md`); a note
 * (any other `.md`); or anything else. Machinery (the manifest, `.gitignore`, the recipients file) is
 * not listed. Whether a document or a note is a Fjord Doc at all needs its contents.
 */
export type FileKind = "payload" | "stray" | "misplacedPayload" | "document" | "note" | "other";

export interface ClassifiedFile {
  /** Repository-relative. */
  path: string;
  /** Relative to the vault's directory. */
  relative: string;
  /** What a person knows it by: a payload without its suffix. */
  logical: string;
  kind: FileKind;
  size: number;
}

export interface VaultListing {
  /** The vault's address: a directory at the repository root. */
  directory: string;
  /** The manifest's `name`. */
  name: string | null;
  /** Null when the manifest could not be read. */
  encrypted: boolean | null;
  fileNaming: string | null;
  suffix: string | null;
  /** Why the manifest could not be read, if it could not. Such a vault has no known files. */
  manifestError: string | null;
  files: ClassifiedFile[];
}

export interface Discovery {
  /** The vaults at the repository root, sorted by directory. */
  vaults: VaultListing[];
  /** Where a vault manifest is that may not be: a repository root or deeper than one directory. */
  nested: string[];
}

/** What to add to a repository that is not a Fjord repository (`fjord-core`'s `scaffold::plan_setup`). */
export interface SetupOptions {
  /** `fjord.json`'s `name`. */
  repositoryName: string;
  /** The vault's directory at the root, which is also its display name. */
  vault: string;
  /** Tool and version, recorded in `fjord.json`'s `generator`. */
  generator: string;
}

/** What is already in the repository: the path of every file (a root listing's names are enough), and `.gitattributes`'s text if it has one. */
export interface SetupExisting {
  paths: string[];
  gitattributes: string | null;
}

export type SetupRefusalCode = "already_fjord" | "invalid_vault_name" | "vault_name_taken" | "gitattributes_not_read";

export type SetupResult =
  | {
      ok: true;
      /** `create`, or `append` for the `.gitattributes` that was there (its `contents` are the whole new file). */
      files: { path: string; contents: string; change: "create" | "append" }[];
      repositoryId: string;
      vaultId: string;
      createdAt: string;
    }
  | { ok: false; error: { code: SetupRefusalCode; message: string } };

/**
 * Two edits of one text merged (`fjord-core`'s `merge3`, the merge the CLI uses). `text` is the merged text when `clean`;
 * otherwise it has each conflict between marker lines, with both sides in it.
 */
export interface MergeResult {
  clean: boolean;
  conflicts: number;
  text: string;
}

/** `fjord.json`, read. `raw` is the whole manifest as written, which a rewrite must preserve. */
export type RepositoryManifest =
  | {
      ok: true;
      version: number | null;
      id: string | null;
      name: string | null;
      createdAt: string | null;
      vaultsState: "entries" | "absent" | "notAnArray";
      vaults: { path: string | null; id: string | null }[] | null;
      raw: Record<string, unknown>;
    }
  | { ok: false; error: string };
