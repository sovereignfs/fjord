import { isProviderError } from "../providers/errors";
import { assertWritablePath } from "../providers/validate";
import type { Fjord } from "../format/wasm";
import type { ConvertRefusalCode } from "../format/types";
import type { Identity, Provider, RepositoryRef } from "../providers/types";
import { looksEncrypted } from "../working/ciphertext";
import type { WorkingCopyService } from "../working/service";
import { formatIdentity } from "../working/version";
import { fileAt, filesUnder } from "./delete";

/**
 * Making a whole vault encrypted, or plaintext again (RFC 0003, spec §6.7), from the browser. The server has no key, so the **browser** encrypts or decrypts every file and
 * sends what belongs in the vault afterwards; this puts them in **one commit** with the new manifest, never forced, over nothing. The commit-line equivalent is
 * `fjord encrypt <vault> --permanent` and `fjord decrypt <vault> --permanent`; the temporary form of those (a checkout) has no counterpart here, because a browser never
 * holds a decrypted vault on a disk: an encrypted file is opened, edited and sealed again one at a time.
 *
 * What it holds to, whatever the page sent (invariant 1, spec §6.5):
 *  - **The vault is in one form before and in the other after, in the same commit.** The manifest, the recipients file and the plaintext guard are `fjord-core`'s (the CLI's own planner),
 *    not the page's; the page supplies the files. Plaintext goes into the commit only as the files of a vault whose manifest, in that commit, says it is plaintext, and ciphertext only as an
 *    encrypted vault's.
 *  - **Every file is converted.** The files sent are exactly the vault's files: one left out would stay in the old form beside the new manifest, and one not there is refused.
 *  - **What was shown is what is converted:** each file only if it is still the blob the page read, and with no draft (a draft is a different text from the one converted).
 *  - **Nothing is put over anything**, every name passes `fjord-core`'s path rules, and a site's content is never encrypted (spec §3.1).
 *  - **The history is not rewritten.** Encrypting leaves what was committed in the clear in the earlier commits; decrypting puts it in this one. The page says so before it asks.
 */
export interface ConvertDeps {
  provider: Provider;
  ref: RepositoryRef;
  branch: string;
  format: Pick<Fjord, "checkName" | "caseCollisions" | "planVaultEncryption" | "planVaultDecryption">;
  drafts: Pick<WorkingCopyService, "paths">;
}

/** One file of the vault as it was (`path`, at `blob`) and as it is to be (`to`, holding `content`). */
export interface ConvertedFile {
  path: string;
  blob: string;
  to: string;
  content: Uint8Array;
}

export type ConvertResult =
  | { ok: true; commit: string; files: ConvertedFile[] }
  | {
      ok: false;
      reason:
        | ConvertRefusalCode
        | "gone"
        | "site"
        | "too_many"
        | "too_large"
        | "upstream_changed"
        | "missing_files"
        | "has_drafts"
        | "bad_path"
        | "wrong_form"
        | "path_taken"
        | "head_moved"
        | "read_only"
        | "bad_token"
        | "unavailable";
      /** Paths the request left out or did not expect, for `missing_files`; names already taken, for `path_taken`. */
      paths?: string[];
      message?: string;
    };

const ATTEMPTS = 2;
/** A vault this large is converted with the command line: a browser would hold all of it at once. */
export const MAX_FILES = 300;
const MANIFEST = "fjord.vault.json";
const AGE = ".age";
const leaf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const folder = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const text = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

function writable(path: string): boolean {
  try {
    assertWritablePath(path);
    return true;
  } catch {
    return false;
  }
}

/** The message of the commit: what was done to which vault and how many files, nothing of their names or contents. */
export function convertMessage(direction: "encrypt" | "decrypt", vault: string, files: number, recipients: number): string {
  const count = `${files} ${files === 1 ? "file" : "files"}`;
  return direction === "encrypt"
    ? `Encrypt vault ${vault}\n\n${count} encrypted with age to ${recipients} ${recipients === 1 ? "recipient" : "recipients"}.`
    : `Decrypt vault ${vault}\n\n${count} decrypted: the vault is now plaintext.`;
}

/** What the page needs to convert a vault: whether it is encrypted, how it names its files, and every file (the bytes of each, and the blob they are of). */
export type VaultSnapshot =
  | { ok: true; encrypted: boolean; naming: "plain" | "id"; files: { path: string; blob: string; content: Uint8Array }[] }
  | { ok: false; reason: "gone" | "site" | "too_many" | "too_large" | "bad_token" | "unavailable" };

/** The most bytes of a vault a page is handed to convert. A vault larger than this is converted with the command line. */
export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * The vault's files as the page will convert them, at the head the commit will be made on top of. Read-only: it is the repository's own content, handed to the person who connected it, and
 * an encrypted vault's files are still ciphertext. A vault's machinery (its manifest, and for an encrypted one its recipients file and guard) is not a file to convert, and is left out.
 */
export async function snapshotVault(deps: Pick<ConvertDeps, "provider" | "ref" | "branch">, vault: string): Promise<VaultSnapshot> {
  if (vault === "" || vault.includes("/")) return { ok: false, reason: "gone" };
  try {
    const head = await deps.provider.getHead(deps.ref, deps.branch);
    if (!head.changed) throw new Error("the host answered a head request with no etag as unchanged");
    const commit = head.head.commit;
    const manifestEntry = await fileAt(deps.provider, deps.ref, commit, `${vault}/${MANIFEST}`);
    if (!manifestEntry) return { ok: false, reason: "gone" };
    const root = await fileAt(deps.provider, deps.ref, commit, "fjord.json");
    if (root && (JSON.parse(text(await deps.provider.readBlob(deps.ref, root.id, { maxBytes: 1024 * 1024 }))) as { kind?: unknown }).kind === "ssg") return { ok: false, reason: "site" };
    const manifest = JSON.parse(text(await deps.provider.readBlob(deps.ref, manifestEntry.id, { maxBytes: 1024 * 1024 }))) as { encryption?: { recipients?: unknown } | null; fileNaming?: unknown };
    const encrypted = manifest.encryption !== null && typeof manifest.encryption === "object";
    const present = await filesUnder(deps.provider, deps.ref, commit, vault, MAX_FILES + 8);
    if (present === "too_many") return { ok: false, reason: "too_many" };

    const recipients = encrypted && typeof manifest.encryption?.recipients === "string" ? `${vault}/${manifest.encryption.recipients}` : `${vault}/recipients.txt`;
    const machinery = new Set([`${vault}/${MANIFEST}`, ...(encrypted ? [recipients, `${vault}/.gitignore`] : [])]);
    const wanted = present.filter((entry) => !machinery.has(entry.path));
    if (wanted.length > MAX_FILES) return { ok: false, reason: "too_many" };
    let total = 0;
    const files: { path: string; blob: string; content: Uint8Array }[] = [];
    for (const entry of wanted) {
      if ((entry.size ?? 0) > MAX_FILE_BYTES) return { ok: false, reason: "too_large" };
      const content = await deps.provider.readBlob(deps.ref, entry.id, { maxBytes: MAX_FILE_BYTES });
      total += content.byteLength;
      if (total > MAX_SNAPSHOT_BYTES) return { ok: false, reason: "too_large" };
      files.push({ path: entry.path, blob: entry.id, content });
    }
    return { ok: true, encrypted, naming: manifest.fileNaming === "id" ? "id" : "plain", files };
  } catch (error) {
    if (isProviderError(error, "unauthorized") || isProviderError(error, "forbidden")) return { ok: false, reason: "bad_token" };
    if (isProviderError(error, "not_found") || isProviderError(error, "unavailable") || isProviderError(error, "rate_limited")) return { ok: false, reason: "unavailable" };
    throw error;
  }
}

export async function convertVault(
  deps: ConvertDeps,
  input: { connectionId: number; vault: string; direction: "encrypt" | "decrypt"; recipients: string[]; files: ConvertedFile[]; author: Identity },
): Promise<ConvertResult> {
  const { vault, direction } = input;
  if (vault === "" || vault.includes("/") || input.files.length > MAX_FILES) return { ok: false, reason: "too_many" };

  // What the bytes must be, whatever the page says they are (spec §6.5).
  for (const file of input.files) {
    if (!file.path.startsWith(`${vault}/`) || !file.to.startsWith(`${vault}/`) || !writable(file.to) || file.to.split("/").some((segment) => deps.format.checkName(segment).length > 0)) {
      return { ok: false, reason: "bad_path" };
    }
    if (direction === "encrypt") {
      if (!looksEncrypted(file.content)) return { ok: false, reason: "wrong_form" };
      if (file.to !== `${file.path}${AGE}`) return { ok: false, reason: "bad_path" };
    } else {
      if (looksEncrypted(file.content)) return { ok: false, reason: "wrong_form" };
      if (!file.path.endsWith(AGE) || folder(file.to) !== folder(file.path) || leaf(file.to) === "" || leaf(file.to).endsWith(AGE)) return { ok: false, reason: "bad_path" };
    }
  }
  const mapped = new Set(input.files.map((file) => file.path));
  if (mapped.size !== input.files.length || new Set(input.files.map((file) => file.to.toLowerCase())).size !== input.files.length) return { ok: false, reason: "path_taken" };

  if ((await deps.drafts.paths(input.connectionId)).some((path) => path.startsWith(`${vault}/`))) return { ok: false, reason: "has_drafts" };

  try {
    for (let attempt = 1; ; attempt++) {
      const head = await deps.provider.getHead(deps.ref, deps.branch);
      if (!head.changed) throw new Error("the host answered a head request with no etag as unchanged");
      const expectedHead = head.head.commit;
      const read = async (path: string) => {
        const entry = await fileAt(deps.provider, deps.ref, expectedHead, path);
        return entry ? { entry, text: text(await deps.provider.readBlob(deps.ref, entry.id, { maxBytes: 1024 * 1024 })) } : undefined;
      };

      const manifest = await read(`${vault}/${MANIFEST}`);
      if (!manifest) return { ok: false, reason: "gone" };
      const root = await read("fjord.json");
      if (root && (JSON.parse(root.text) as { kind?: unknown }).kind === "ssg") return { ok: false, reason: "site" };

      // The manifest the vault will have, and what goes with it: `fjord-core`'s, the CLI's.
      const changes: ({ path: string; delete: true } | { path: string; content: Uint8Array })[] = [];
      const bytes = (value: string) => new TextEncoder().encode(value);
      const vaultFiles: string[] = [];
      let recipientsPath: string | undefined;
      let guardAtHead: string | undefined;
      if (direction === "encrypt") {
        const attributes = await read(".gitattributes");
        const plan = deps.format.planVaultEncryption(manifest.text, input.recipients, attributes?.text ?? null);
        if (!plan.ok) return { ok: false, reason: plan.error.code, message: plan.error.message };
        for (const file of plan.files) if (await fileAt(deps.provider, deps.ref, expectedHead, `${vault}/${file.path}`)) return { ok: false, reason: "path_taken", paths: [`${vault}/${file.path}`] };
        changes.push({ path: `${vault}/${MANIFEST}`, content: bytes(plan.manifest) }, ...plan.files.map((file) => ({ path: `${vault}/${file.path}`, content: bytes(file.contents) })));
        if (plan.gitattributes !== null) changes.push({ path: ".gitattributes", content: bytes(plan.gitattributes) });
      } else {
        const plan = deps.format.planVaultDecryption(manifest.text);
        if (!plan.ok) return { ok: false, reason: plan.error.code, message: plan.error.message };
        changes.push({ path: `${vault}/${MANIFEST}`, content: bytes(plan.manifest) });
        const declared = (JSON.parse(manifest.text) as { encryption?: { recipients?: unknown } }).encryption?.recipients;
        recipientsPath = `${vault}/${typeof declared === "string" ? declared : "recipients.txt"}`;
        const guard = await read(`${vault}/.gitignore`);
        guardAtHead = guard && guard.text === plan.guard ? guard.entry.path : undefined;
      }

      // The files that are there are the files that were sent, each at the blob that was shown.
      const present = await filesUnder(deps.provider, deps.ref, expectedHead, vault, MAX_FILES + 8);
      if (present === "too_many") return { ok: false, reason: "too_many" };
      const machinery = new Set([`${vault}/${MANIFEST}`, ...(recipientsPath && direction === "decrypt" ? [recipientsPath] : []), ...(guardAtHead ? [guardAtHead] : [])]);
      const content = present.filter((entry) => !machinery.has(entry.path));
      const sent = new Map(input.files.map((file) => [file.path, file]));
      const stray = [...content.filter((entry) => !sent.has(entry.path)).map((entry) => entry.path), ...input.files.filter((file) => !content.some((entry) => entry.path === file.path)).map((file) => file.path)];
      if (stray.length > 0) return { ok: false, reason: "missing_files", paths: stray };
      if (content.some((entry) => sent.get(entry.path)?.blob !== entry.id)) return { ok: false, reason: "upstream_changed" };
      for (const entry of content) vaultFiles.push(entry.path);

      // Nothing may land on a name the vault does not give up: a file's new name is taken only by a file of this vault that is leaving.
      const leaving = new Set(vaultFiles);
      const keep = present.filter((entry) => !leaving.has(entry.path) && !machinery.has(entry.path)).map((entry) => entry.path);
      const names = [...keep, ...input.files.map((file) => file.to)];
      if (names.length > 0 && deps.format.caseCollisions(names).length > 0) return { ok: false, reason: "path_taken", paths: input.files.map((file) => file.to).filter((to) => keep.some((other) => other.toLowerCase() === to.toLowerCase())) };

      for (const file of input.files) changes.push({ path: file.path, delete: true as const }, { path: file.to, content: file.content });
      if (direction === "decrypt") {
        if (recipientsPath && (await fileAt(deps.provider, deps.ref, expectedHead, recipientsPath))) changes.push({ path: recipientsPath, delete: true as const });
        if (guardAtHead) changes.push({ path: guardAtHead, delete: true as const });
      }

      try {
        const made = await deps.provider.commit(deps.ref, {
          branch: deps.branch,
          expectedHead,
          message: convertMessage(direction, vault, input.files.length, input.recipients.length),
          author: formatIdentity(input.author),
          changes,
        });
        return { ok: true, commit: made.commit, files: input.files };
      } catch (error) {
        if (isProviderError(error, "head_moved")) {
          if (attempt < ATTEMPTS) continue;
          return { ok: false, reason: "head_moved" };
        }
        throw error;
      }
    }
  } catch (error) {
    if (isProviderError(error, "forbidden")) return { ok: false, reason: "read_only" };
    if (isProviderError(error, "unauthorized")) return { ok: false, reason: "bad_token" };
    if (isProviderError(error, "not_found") || isProviderError(error, "unavailable") || isProviderError(error, "rate_limited")) return { ok: false, reason: "unavailable" };
    throw error;
  }
}
