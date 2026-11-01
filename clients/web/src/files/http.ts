import { isCredentialError } from "../crypto/errors";
import type { LocalMinute } from "../format/types";
import { isProviderError } from "../providers/errors";
import type { Identity } from "../providers/types";
import { type Caller, isRepositoryPath } from "../working/http";
import { MAX_CIPHERTEXT_BYTES, fromBase64, whyNotCiphertext } from "../working/ciphertext";
import type { CreateResult, FileKind, VaultRefusal } from "./create";
import type { CreateEncryptedResult, EncryptedVaultRefusal } from "./create-encrypted";
import { MAX_TITLE_CHARS } from "./create";
import type { DeleteResult, DeleteTarget } from "./delete";
import type { MoveResult } from "./move";
import type { RestoreResult } from "./restore";

/**
 * The HTTP face of making files (`/api/connections/<id>/files`): who may call, what they may send, what they are told.
 * Like `src/working/http.ts`, written against `Request` and `Response` and handed the caller, so the rules are tested
 * directly and the route file is only the glue that finds the session.
 *
 *  - Nobody who is not signed in: 401, before anything is read.
 *  - A write must come from this instance's own pages: its `Origin` is checked against `FJORD_URL`.
 *  - An account makes files in its own connections only: another's is 404, as if it were not there.
 *  - What is sent is a place and a title, never a name or a text: the name and the header are `fjord-core`'s.
 *
 * The same rules hold for deleting a note, a document or a folder (`handleDelete`) and for putting back what was deleted
 * (`handleRestore`): what is sent is a place and what the person was shown, and the app finds the rest.
 */
export interface Deps {
  /**
   * Make a file in one of the caller's repositories. `found: false` if it is not the caller's (or not there). `author` is
   * the caller as their account names them.
   */
  create: (
    accountId: string,
    id: number,
    input: { vault: string; folder: string; kind: FileKind; title: string; localMinute: LocalMinute; author: Identity },
  ) => Promise<{ found: false } | { found: true; result: CreateResult | { ok: false; reason: VaultRefusal } }>;
  /**
   * Make a file in an encrypted vault of one of the caller's repositories (ROADMAP 2b.4) from ciphertext the browser made. `title` is empty
   * for a vault that names its files by id. `found: false` if it is not the caller's (or not there).
   */
  createEncrypted: (
    accountId: string,
    id: number,
    input: { vault: string; folder: string; kind: FileKind; title: string; localMinute: LocalMinute; ciphertext: Uint8Array; author: Identity },
  ) => Promise<{ found: false } | { found: true; result: CreateEncryptedResult | { ok: false; reason: EncryptedVaultRefusal | "wrong_shape" } }>;
  /**
   * Delete a note, a document or a folder of one of the caller's repositories (ROADMAP 1b.12). `found: false` if it is not the
   * caller's (or not there).
   */
  delete: (
    accountId: string,
    id: number,
    input: { vault: string; target: DeleteTarget; author: Identity },
  ) => Promise<{ found: false } | { found: true; result: DeleteResult | { ok: false; reason: VaultRefusal } }>;
  /**
   * Rename or move a note, a document or a folder of one of the caller's repositories to a new path (ROADMAP 1b.11). `found:
   * false` if it is not the caller's (or not there). `where` says which vault was refused, the one it is in or the one it is
   * going to.
   */
  move: (
    accountId: string,
    id: number,
    input: { vault: string; target: DeleteTarget; destination: string; author: Identity },
  ) => Promise<{ found: false } | { found: true; result: MoveResult | { ok: false; reason: VaultRefusal; where: "source" | "destination" } }>;
  /** Put back deletions the caller's repository has records of, at the paths they had or, for one, the one given. */
  restore: (accountId: string, id: number, input: { ids: number[]; path: string | undefined; author: Identity }) => Promise<{ found: false } | { found: true; result: RestoreResult }>;
  /**
   * A header with its `title` set or, if it is empty, taken away (ROADMAP 1b.5), written by `fjord-core`. Nothing is read from
   * or written to the repository: the page holds the header and gets it back. `found: false` if the connection is not the
   * caller's.
   */
  header: (accountId: string, id: number, input: { header: string; title: string }) => Promise<{ found: false } | { found: true; result: { ok: true; header: string } | { ok: false; reason: "unreadable" } }>;
  /** The instance's origin, `FJORD_URL`. */
  origin: string;
}

const MAX_BODY_CHARS = 8_000;
const MAX_PATH_CHARS = 1_000;
const MAX_VAULT_CHARS = 255;
const CONNECTION_ID = /^[1-9][0-9]{0,15}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
const failure = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => json(status, { error: { code, message, ...extra } });
const notFound = () => failure(404, "not_found", "There is no such connection.");

/** `POST` makes a note or a document, `{ vault, folder, kind, title?, localMinute }`: one commit that adds one file. */
export async function handleCreate(request: Request, caller: Caller | null, deps: Deps, id: string): Promise<Response> {
  if (request.method !== "POST") return failure(405, "method_not_allowed", "That method is not allowed here.");
  if (!caller) return failure(401, "unauthorized", "Sign in first.");
  if (request.headers.get("origin") !== deps.origin) return failure(403, "forbidden", "This request did not come from this site.");
  const number = CONNECTION_ID.test(id) ? Number(id) : undefined;
  if (number === undefined) return notFound();

  try {
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return failure(415, "unsupported_media_type", "Send JSON.");
    const text = await request.text();
    if (text.length > MAX_BODY_CHARS) return failure(413, "too_large", "That request is too large.");
    const body = parse(text);
    if (!body) return failure(400, "invalid_request", "Send a JSON object.");

    const { vault, folder, kind, title, localMinute } = body;
    if (typeof vault !== "string" || vault.length > MAX_VAULT_CHARS || vault.includes("/") || !isRepositoryPath(vault)) return failure(400, "invalid_request", "Say which vault, by its directory.");
    if (typeof folder !== "string" || (folder !== "" && !isRepositoryPath(folder))) return failure(400, "invalid_request", "Say which folder of the vault, by its path, or \"\" for its top.");
    if (kind !== "note" && kind !== "document") return failure(400, "invalid_request", "Say whether to make a note or a document.");
    if (title !== undefined && title !== null && (typeof title !== "string" || title.length > MAX_TITLE_CHARS || CONTROL.test(title) || !title.isWellFormed())) {
      return failure(400, "invalid_request", `Send the title as one line of at most ${MAX_TITLE_CHARS} characters, or leave it out.`);
    }
    const minute = readMinute(localMinute);
    if (!minute) return failure(400, "invalid_request", "Send the local date and time as whole numbers: year, month, day, hour and minute.");

    const outcome = await deps.create(caller.accountId, number, {
      vault,
      folder,
      kind,
      title: typeof title === "string" ? title : "",
      localMinute: minute,
      author: { name: caller.name, email: caller.email },
    });
    if (!outcome.found) return notFound();
    const { result } = outcome;
    if (result.ok) return json(201, { path: result.path, commit: result.commit });
    const refusal = REFUSALS[result.reason];
    return failure(refusal.status, result.reason, refusal.message);
  } catch (error) {
    return fromError(error);
  }
}

/** A new file is a title and a header: its ciphertext is small, and a larger one is not a new file. */
const MAX_NEW_CIPHERTEXT_BYTES = 64 * 1024;
const MAX_ENCRYPTED_BODY_CHARS = Math.ceil((MAX_NEW_CIPHERTEXT_BYTES * 4) / 3) + MAX_BODY_CHARS;

/**
 * `POST` makes a note or a document in an **encrypted** vault, `{ vault, folder, kind, title?, localMinute, ciphertext }` (ROADMAP 2b.4): the browser wrote the
 * file and encrypted it to the vault's recipients, and this commits those bytes as one new file. The server has no key. `ciphertext` is base64 and must begin
 * as an age file does; plain text is refused. A vault that names its files by id is sent no title (the name is inside the container; `wrong_shape` if it is), and one that names them
 * by their names is sent the title they are named by.
 */
export async function handleCreateEncrypted(request: Request, caller: Caller | null, deps: Deps, id: string): Promise<Response> {
  if (request.method !== "POST") return failure(405, "method_not_allowed", "That method is not allowed here.");
  if (!caller) return failure(401, "unauthorized", "Sign in first.");
  if (request.headers.get("origin") !== deps.origin) return failure(403, "forbidden", "This request did not come from this site.");
  const number = CONNECTION_ID.test(id) ? Number(id) : undefined;
  if (number === undefined) return notFound();

  try {
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return failure(415, "unsupported_media_type", "Send JSON.");
    const text = await request.text();
    if (text.length > MAX_ENCRYPTED_BODY_CHARS) return failure(413, "too_large", "That request is too large.");
    const body = parse(text);
    if (!body) return failure(400, "invalid_request", "Send a JSON object.");

    const { vault, folder, kind, title, localMinute, ciphertext } = body;
    if (typeof vault !== "string" || vault.length > MAX_VAULT_CHARS || vault.includes("/") || !isRepositoryPath(vault)) return failure(400, "invalid_request", "Say which vault, by its directory.");
    if (typeof folder !== "string" || (folder !== "" && !isRepositoryPath(folder))) return failure(400, "invalid_request", "Say which folder of the vault, by its path, or \"\" for its top.");
    if (kind !== "note" && kind !== "document") return failure(400, "invalid_request", "Say whether to make a note or a document.");
    if (title !== undefined && title !== null && (typeof title !== "string" || title.length > MAX_TITLE_CHARS || CONTROL.test(title) || !title.isWellFormed())) {
      return failure(400, "invalid_request", `Send the title as one line of at most ${MAX_TITLE_CHARS} characters, or leave it out.`);
    }
    const minute = readMinute(localMinute);
    if (!minute) return failure(400, "invalid_request", "Send the local date and time as whole numbers: year, month, day, hour and minute.");
    if (typeof ciphertext !== "string") return failure(400, "invalid_request", "Send the encrypted file as base64 text.");
    const why = whyNotCiphertext(ciphertext);
    const bytes = why === undefined ? fromBase64(ciphertext) : undefined;
    if (bytes === undefined || bytes.length > MAX_NEW_CIPHERTEXT_BYTES || bytes.length > MAX_CIPHERTEXT_BYTES) {
      return failure(422, "not_ciphertext", `${why ?? "It is larger than a new file can be."} Only an encrypted file is put into an encrypted vault.`);
    }

    const outcome = await deps.createEncrypted(caller.accountId, number, {
      vault,
      folder,
      kind,
      title: typeof title === "string" ? title : "",
      localMinute: minute,
      ciphertext: bytes,
      author: { name: caller.name, email: caller.email },
    });
    if (!outcome.found) return notFound();
    const { result } = outcome;
    if (result.ok) return json(201, { path: result.path, commit: result.commit });
    const refusal = ENCRYPTED_REFUSALS[result.reason];
    return failure(refusal.status, result.reason, refusal.message);
  } catch (error) {
    return fromError(error);
  }
}

const MAX_HEADER_CHARS = 64_000;

/**
 * `POST` sets (or, with an empty title, takes away) a header's `title`: `{ header, title }` answers `{ header }`, the header
 * rewritten by the format module with every other key kept (ROADMAP 1b.5). Only the header is sent, never the body.
 */
export async function handleHeader(request: Request, caller: Caller | null, deps: Deps, id: string): Promise<Response> {
  if (request.method !== "POST") return failure(405, "method_not_allowed", "That method is not allowed here.");
  if (!caller) return failure(401, "unauthorized", "Sign in first.");
  if (request.headers.get("origin") !== deps.origin) return failure(403, "forbidden", "This request did not come from this site.");
  const number = CONNECTION_ID.test(id) ? Number(id) : undefined;
  if (number === undefined) return notFound();

  try {
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return failure(415, "unsupported_media_type", "Send JSON.");
    const text = await request.text();
    if (text.length > MAX_HEADER_CHARS + MAX_BODY_CHARS) return failure(413, "too_large", "That request is too large.");
    const body = parse(text);
    if (!body) return failure(400, "invalid_request", "Send a JSON object.");
    const { header, title } = body;
    if (typeof header !== "string" || header.length > MAX_HEADER_CHARS || !header.isWellFormed()) return failure(400, "invalid_request", "Send the header as text.");
    if (typeof title !== "string" || title.length > MAX_TITLE_CHARS || CONTROL.test(title) || !title.isWellFormed()) {
      return failure(400, "invalid_request", `Send the title as one line of at most ${MAX_TITLE_CHARS} characters, or empty to take it away.`);
    }
    const outcome = await deps.header(caller.accountId, number, { header, title });
    if (!outcome.found) return notFound();
    if (outcome.result.ok) return json(200, { header: outcome.result.header });
    return failure(422, "unreadable_header", "This file's header cannot be read, so its title cannot be changed from here.");
  } catch (error) {
    return fromError(error);
  }
}

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  return undefined;
}

/** The writer's own local time, which a note with nothing to name it by is named after: real-looking whole numbers. */
function readMinute(value: unknown): LocalMinute | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { year, month, day, hour, minute } = value as Record<string, unknown>;
  const within = (n: unknown, low: number, high: number): n is number => typeof n === "number" && Number.isInteger(n) && n >= low && n <= high;
  if (!within(year, 2000, 2200) || !within(month, 1, 12) || !within(day, 1, 31) || !within(hour, 0, 23) || !within(minute, 0, 59)) return undefined;
  return { year, month, day, hour, minute };
}

/** What each reason nothing was made is told as. Nothing was written, in each. */
const REFUSALS: Record<Extract<CreateResult, { ok: false }>["reason"] | VaultRefusal, { status: number; message: string }> = {
  unknown_vault: { status: 422, message: "This repository has no such vault." },
  encrypted_vault: { status: 422, message: "Files cannot be made in an encrypted vault in this version." },
  unsupported_vault: { status: 422, message: "This vault's manifest cannot be read, or it does not use plain file names, so files cannot be made in it from here." },
  folder_gone: { status: 409, message: "That folder is no longer in the repository. Nothing was made." },
  bad_title: { status: 422, message: "A document needs a title with some letters or digits in it to name its file by." },
  head_moved: { status: 409, message: "The repository kept changing while this was being made. Nothing was made. Try again." },
  read_only: { status: 422, message: "That token can read this repository but not write to it, so nothing was made. Create the token with the repository permission “Contents: Read and write”, and connect the repository again." },
  bad_token: { status: 422, message: "The git host did not accept this repository's token. Connect the repository again with a new one." },
  unavailable: { status: 502, message: "Could not reach the git host just now. Nothing was made. Try again in a moment." },
};

const ENCRYPTED_REFUSALS: Record<Extract<CreateEncryptedResult, { ok: false }>["reason"] | EncryptedVaultRefusal | "wrong_shape", { status: number; message: string }> = {
  ...REFUSALS,
  not_encrypted: { status: 422, message: "That vault is not encrypted. Files are made in it the ordinary way." },
  unsupported_vault: { status: 422, message: "This vault's manifest cannot be read, or it does not use age with binary files in the container its file names need, so files cannot be made in it from here." },
  wrong_shape: { status: 422, message: "A vault that names its files by id must not be sent the title: the name is kept inside the encrypted file." },
};

/** What a person is told. An error we did not expect is logged by name, never by message, and answered plainly. */
function fromError(error: unknown): Response {
  if (isCredentialError(error, "no_key")) return failure(503, "not_configured", "This instance cannot read repositories yet: its administrator needs to set FJORD_ENCRYPTION_KEY.");
  if (isProviderError(error, "rate_limited")) return failure(429, "rate_limited", "The git host is limiting requests. Try again in a moment.");
  console.error(`[fjord] files: unexpected ${error instanceof Error ? error.name : "failure"}`);
  return failure(500, "internal_error", "Something went wrong on our side. Try again.");
}

// --- Deleting and putting back (ROADMAP 1b.12) ---------------------------------------------------------------------

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_IDS = 1000;

/** `POST` deletes `{ vault, type: "file", path, blob }` or `{ vault, type: "folder", path, files }`: one commit. */
export async function handleDelete(request: Request, caller: Caller | null, deps: Deps, id: string): Promise<Response> {
  const gate = await gateway(request, caller, deps, id);
  if (gate instanceof Response) return gate;

  try {
    const { body, number } = gate;
    const { vault, type, path, blob, files } = body;
    if (typeof vault !== "string" || vault.length > MAX_VAULT_CHARS || vault.includes("/") || !isRepositoryPath(vault)) return failure(400, "invalid_request", "Say which vault, by its directory.");
    if (!isRepositoryPath(path)) return failure(400, "invalid_request", "Say what to delete, by its path in the repository.");
    let target: DeleteTarget;
    if (type === "file") {
      if (typeof blob !== "string" || !OBJECT_ID.test(blob)) return failure(400, "invalid_request", "Say which version of the file you were shown, by its git object id.");
      target = { type: "file", path, blob };
    } else if (type === "folder") {
      if (typeof files !== "number" || !Number.isInteger(files) || files < 1 || files > 1_000_000) return failure(400, "invalid_request", "Say how many files the folder holds, as you were told.");
      target = { type: "folder", path, files };
    } else {
      return failure(400, "invalid_request", "Say whether to delete a file or a folder.");
    }

    const outcome = await deps.delete(caller!.accountId, number, { vault, target, author: { name: caller!.name, email: caller!.email } });
    if (!outcome.found) return notFound();
    const { result } = outcome;
    if (result.ok) return json(200, { commit: result.commit, files: result.files, deletions: result.deletions });
    if (result.reason === "unknown_vault" || result.reason === "encrypted_vault" || result.reason === "unsupported_vault") {
      const refusal = REFUSALS[result.reason];
      return failure(refusal.status, result.reason, refusal.message);
    }
    const refusal = DELETE_REFUSALS[result.reason];
    const detail = "detail" in result ? result.detail : undefined;
    return failure(refusal.status, result.reason, refusal.message(detail), detail === undefined ? {} : { detail });
  } catch (error) {
    return fromError(error);
  }
}

/**
 * `POST` renames or moves a file or a folder, `{ vault, type, path, blob | files, destination }`: one commit that puts the same
 * files at `destination` (a path in the repository, whose last step is the new name). What is sent is what the page showed
 * (the file's blob, the folder's file count), so only that moves; the new name is checked by the format module, and nothing
 * is ever put over anything.
 */
export async function handleMove(request: Request, caller: Caller | null, deps: Deps, id: string): Promise<Response> {
  const gate = await gateway(request, caller, deps, id);
  if (gate instanceof Response) return gate;

  try {
    const { body, number } = gate;
    const { vault, type, path, blob, files, destination } = body;
    if (typeof vault !== "string" || vault.length > MAX_VAULT_CHARS || vault.includes("/") || !isRepositoryPath(vault)) return failure(400, "invalid_request", "Say which vault, by its directory.");
    if (!isRepositoryPath(path)) return failure(400, "invalid_request", "Say what to move, by its path in the repository.");
    if (!isRepositoryPath(destination) || destination.length > MAX_PATH_CHARS || !destination.isWellFormed() || CONTROL.test(destination)) {
      return failure(400, "invalid_request", "Say where it goes, by a path in the repository.");
    }
    let target: DeleteTarget;
    if (type === "file") {
      if (typeof blob !== "string" || !OBJECT_ID.test(blob)) return failure(400, "invalid_request", "Say which version of the file you were shown, by its git object id.");
      target = { type: "file", path, blob };
    } else if (type === "folder") {
      if (typeof files !== "number" || !Number.isInteger(files) || files < 1 || files > 1_000_000) return failure(400, "invalid_request", "Say how many files the folder holds, as you were told.");
      target = { type: "folder", path, files };
    } else {
      return failure(400, "invalid_request", "Say whether to move a file or a folder.");
    }

    const outcome = await deps.move(caller!.accountId, number, { vault, target, destination, author: { name: caller!.name, email: caller!.email } });
    if (!outcome.found) return notFound();
    const { result } = outcome;
    if (result.ok) return json(200, { commit: result.commit, files: result.files, moved: result.moved });
    if (result.reason === "unknown_vault" || result.reason === "encrypted_vault" || result.reason === "unsupported_vault") {
      const refusal = "where" in result && result.where === "destination" ? MOVE_DESTINATION_REFUSALS[result.reason] : REFUSALS[result.reason];
      return failure(refusal.status, result.reason, refusal.message);
    }
    const refusal = MOVE_REFUSALS[result.reason];
    const detail = "detail" in result ? result.detail : undefined;
    const taken = "taken" in result ? result.taken : undefined;
    return failure(refusal.status, result.reason, refusal.message(detail), { ...(detail === undefined ? {} : { detail }), ...(taken === undefined ? {} : { taken }) });
  } catch (error) {
    return fromError(error);
  }
}

/** `POST` puts back what was deleted, `{ ids: [deletion ids], path? }`: one commit, never over anything. */
export async function handleRestore(request: Request, caller: Caller | null, deps: Deps, id: string): Promise<Response> {
  const gate = await gateway(request, caller, deps, id);
  if (gate instanceof Response) return gate;

  try {
    const { body, number } = gate;
    const { ids, path } = body;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_IDS || !ids.every((value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0)) {
      return failure(400, "invalid_request", "Say which deletions to put back, by their numbers.");
    }
    if (path !== undefined && path !== null && !isRepositoryPath(path)) return failure(400, "invalid_request", "Say where to put it, by a path in the repository, or leave it out.");

    const outcome = await deps.restore(caller!.accountId, number, { ids: ids as number[], path: typeof path === "string" ? path : undefined, author: { name: caller!.name, email: caller!.email } });
    if (!outcome.found) return notFound();
    const { result } = outcome;
    if (result.ok) return json(200, { commit: result.commit, paths: result.paths });
    const refusal = RESTORE_REFUSALS[result.reason];
    return failure(refusal.status, result.reason, refusal.message, result.taken ? { taken: result.taken } : {});
  } catch (error) {
    return fromError(error);
  }
}

/** What every write has to be, before its body is looked at: a POST, a signed-in caller, this site, a connection id, JSON. */
async function gateway(request: Request, caller: Caller | null, deps: Deps, id: string): Promise<Response | { body: Record<string, unknown>; number: number }> {
  if (request.method !== "POST") return failure(405, "method_not_allowed", "That method is not allowed here.");
  if (!caller) return failure(401, "unauthorized", "Sign in first.");
  if (request.headers.get("origin") !== deps.origin) return failure(403, "forbidden", "This request did not come from this site.");
  const number = CONNECTION_ID.test(id) ? Number(id) : undefined;
  if (number === undefined) return notFound();
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return failure(415, "unsupported_media_type", "Send JSON.");
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return failure(413, "too_large", "That request is too large.");
  const body = parse(text);
  return body ? { body, number } : failure(400, "invalid_request", "Send a JSON object.");
}

/** What each reason nothing was deleted is told as. Nothing was written, and nothing recorded, in each. */
const DELETE_REFUSALS: Record<Extract<DeleteResult, { ok: false }>["reason"], { status: number; message: (detail: number | string | undefined) => string }> = {
  gone: { status: 409, message: () => "That is no longer in the repository. Nothing was deleted." },
  upstream_changed: { status: 409, message: () => "That note changed in the repository after you looked at it, so it was not deleted. Look at it again." },
  folder_changed: { status: 409, message: (detail) => `That folder now holds ${typeof detail === "number" ? detail : "a different number of"} files, not the number you were told, so nothing was deleted. Look at it again.` },
  too_many: { status: 422, message: () => "That folder holds too many files to delete from here. Delete it from the command line, or in smaller parts." },
  has_drafts: { status: 409, message: (detail) => `${detail ?? "Some"} of the files in that folder have unsaved changes. Save a version of each, or discard the changes, first. Nothing was deleted.` },
  draft_not_saved: { status: 409, message: () => "This note has unsaved changes, and they could not be saved as a version first, so it was not deleted. Open it and save a version, or discard the changes." },
  protected: { status: 422, message: () => "A vault, its manifest and the repository's own files cannot be deleted from here." },
  head_moved: { status: 409, message: () => "The repository kept changing while this was being deleted. Nothing was deleted. Try again." },
  read_only: { status: 422, message: () => "That token can read this repository but not write to it, so nothing was deleted. Create the token with the repository permission “Contents: Read and write”, and connect the repository again." },
  bad_token: { status: 422, message: () => "The git host did not accept this repository's token. Connect the repository again with a new one." },
  unavailable: { status: 502, message: () => "Could not reach the git host just now. Nothing was deleted. Try again in a moment." },
};

/** What each reason nothing was moved is told as. Nothing was written in each. */
const MOVE_REFUSALS: Record<Extract<MoveResult, { ok: false }>["reason"], { status: number; message: (detail: number | string | undefined) => string }> = {
  gone: { status: 409, message: () => "That is no longer in the repository. Nothing was moved." },
  upstream_changed: { status: 409, message: () => "That note changed in the repository after you looked at it, so it was not moved. Look at it again." },
  folder_changed: { status: 409, message: (detail) => `That folder now holds ${typeof detail === "number" ? detail : "a different number of"} files, not the number you were told, so nothing was moved. Look at it again.` },
  too_many: { status: 422, message: () => "That folder holds too many files to move from here. Move it from the command line, or in smaller parts." },
  has_drafts: { status: 409, message: (detail) => `${detail ?? "Some"} of the files in that folder have unsaved changes. Save a version of each, or discard the changes, first. Nothing was moved.` },
  draft_not_saved: { status: 409, message: () => "This note has unsaved changes, and they could not be saved as a version first, so it was not moved. Open it and save a version, or discard the changes." },
  protected: { status: 422, message: () => "A vault, its manifest and the repository's own files cannot be renamed or moved from here." },
  bad_path: { status: 422, message: () => "That is not a name or a place a file can have here. Names cannot hold characters such as : ? * or /, end in a space or a dot, or be one Windows reserves." },
  extension_changed: { status: 422, message: () => "A rename keeps the file's kind: a document stays a .fj.md and a note stays a .md (and an encrypted file keeps its .age)." },
  id_named: { status: 422, message: () => "This vault names its files by identifier, which never changes. A file in it is renamed by changing the name kept inside it, which only your browser can do, with your identity." },
  other_vault: { status: 422, message: () => "A file of an encrypted vault stays in it: moving it to another vault would need your browser to decrypt or encrypt it, which comes later." },
  into_itself: { status: 422, message: () => "A folder cannot be moved into itself." },
  unchanged: { status: 422, message: () => "That is where it is already." },
  path_taken: { status: 409, message: () => "Something is at that name already, or has a name like it that differs only by letter case. Nothing was moved and nothing was replaced. Choose another name." },
  head_moved: { status: 409, message: () => "The repository kept changing while this was being moved. Nothing was moved. Try again." },
  read_only: { status: 422, message: () => "That token can read this repository but not write to it, so nothing was moved. Create the token with the repository permission “Contents: Read and write”, and connect the repository again." },
  bad_token: { status: 422, message: () => "The git host did not accept this repository's token. Connect the repository again with a new one." },
  unavailable: { status: 502, message: () => "Could not reach the git host just now. Nothing was moved. Try again in a moment." },
};

/** The vault something is going to, when that is what is wrong. */
const MOVE_DESTINATION_REFUSALS: Record<VaultRefusal, { status: number; message: string }> = {
  unknown_vault: { status: 422, message: "This repository has no such vault to move it to." },
  encrypted_vault: { status: 422, message: "Nothing can be moved into an encrypted vault from here: it would put plaintext in it. Encrypting on the way in comes later." },
  unsupported_vault: { status: 422, message: "That vault's manifest cannot be read, or it does not use plain file names, so nothing can be moved into it from here." },
};

/** What each reason nothing was put back is told as. Nothing was written in each, and what is there is untouched. */
const RESTORE_REFUSALS: Record<Extract<RestoreResult, { ok: false }>["reason"], { status: number; message: string }> = {
  not_found: { status: 404, message: "There is no such deletion." },
  already_restored: { status: 409, message: "That has been put back already." },
  expired: { status: 409, message: "That was deleted too long ago to be offered here. It is still in the repository's history." },
  bad_path: { status: 422, message: "That is not a place it can be put back: the name is not a valid one, it must stay in a vault and keep its kind of file, and only one file can be given a place." },
  vault_unavailable: { status: 422, message: "Its vault can no longer be written to from here (it is gone, encrypted or not one this version writes)." },
  path_taken: { status: 409, message: "Something is already at that path, or in the way of it, so nothing was put back. Choose another place." },
  id_taken: { status: 409, message: "A file in the repository already has the id of what you are putting back, so putting it back would make two documents of one. Nothing was put back. The files that have it are listed; delete or change one of them first." },
  blob_gone: { status: 422, message: "The repository no longer has this file's content in its history, so it cannot be put back from here." },
  head_moved: { status: 409, message: "The repository kept changing while this was being put back. Nothing was changed. Try again." },
  read_only: { status: 422, message: "That token can read this repository but not write to it, so nothing was put back." },
  bad_token: { status: 422, message: "The git host did not accept this repository's token. Connect the repository again with a new one." },
  unavailable: { status: 502, message: "Could not reach the git host just now. Nothing was put back. Try again in a moment." },
};
