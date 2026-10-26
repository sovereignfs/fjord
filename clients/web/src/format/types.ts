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
