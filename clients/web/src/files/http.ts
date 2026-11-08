import { isCredentialError } from '../crypto/errors';
import type { LocalMinute } from '../format/types';
import { isProviderError } from '../providers/errors';
import type { Identity } from '../providers/types';
import { type Caller, isRepositoryPath } from '../working/http';
import { MAX_CIPHERTEXT_BYTES, fromBase64, whyNotCiphertext } from '../working/ciphertext';
import type { CreateResult, VaultRefusal } from './create';
import type { CreateEncryptedResult, EncryptedVaultRefusal } from './create-encrypted';
import type { TransferResult } from './transfer';
import type { ConvertResult, ConvertedFile, VaultSnapshot } from './convert';
import type { IdentifyResult } from './identify';
import { MAX_TITLE_CHARS } from './create';
import type { DeleteResult, DeleteTarget } from './delete';
import type { MoveResult } from './move';
import type { RestoreResult } from './restore';
import type { EntryResult } from '../journal/entries';
import type { PostResult, SiteRefusal } from '../site/posts';

/** One key of a header to change (ROADMAP 1b.5, 3b.1, 3b.3): its title, its `date` (null takes it away) or its `tags`. */
export type HeaderChange = { header: string } & (
  | { title: string }
  | { date: string | null }
  | { tags: string[] }
  | { field: { key: string; value: string | boolean | null } }
);

/** Why a journal entry cannot be made here: the repository is not a journal, its journal is encrypted (entries are made in the browser), or not one this version writes. */
export type JournalRefusal = 'not_a_journal' | 'encrypted_journal' | 'unsupported_journal';

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
    input: {
      vault: string;
      folder: string;
      /** `folder` is one that is not there yet, made by this file (a new folder). */ newFolder?:
        boolean | undefined;
      title: string;
      localMinute: LocalMinute;
      author: Identity;
    },
  ) => Promise<
    { found: false } | { found: true; result: CreateResult | { ok: false; reason: VaultRefusal } }
  >;
  /**
   * Make a file in an encrypted vault of one of the caller's repositories (ROADMAP 2b.4) from ciphertext the browser made. `title` is empty
   * for a vault that names its files by id. `found: false` if it is not the caller's (or not there).
   */
  createEncrypted: (
    accountId: string,
    id: number,
    input: {
      vault: string;
      folder: string;
      /** `folder` is one that is not there yet, made by this file (a new folder). */ newFolder?:
        boolean | undefined;
      title: string;
      localMinute: LocalMinute;
      ciphertext: Uint8Array;
      author: Identity;
    },
  ) => Promise<
    | { found: false }
    | {
        found: true;
        result:
          CreateEncryptedResult | { ok: false; reason: EncryptedVaultRefusal | 'wrong_shape' };
      }
  >;
  /**
   * Give a Doc of one of the caller's repositories an identifier (ROADMAP 3e.3). `found: false` if it is not the caller's (or not there).
   */
  identify: (
    accountId: string,
    id: number,
    input: { path: string; blob: string; author: Identity },
  ) => Promise<
    { found: false } | { found: true; result: IdentifyResult | { ok: false; reason: VaultRefusal } }
  >;
  /**
   * Delete a note, a document or a folder of one of the caller's repositories (ROADMAP 1b.12). `found: false` if it is not the
   * caller's (or not there).
   */
  delete: (
    accountId: string,
    id: number,
    input: { vault: string; target: DeleteTarget; author: Identity },
  ) => Promise<
    { found: false } | { found: true; result: DeleteResult | { ok: false; reason: VaultRefusal } }
  >;
  /**
   * Rename or move a note, a document or a folder of one of the caller's repositories to a new path (ROADMAP 1b.11). `found:
   * false` if it is not the caller's (or not there). `where` says which vault was refused, the one it is in or the one it is
   * going to.
   */
  move: (
    accountId: string,
    id: number,
    input: { vault: string; target: DeleteTarget; destination: string; author: Identity },
  ) => Promise<
    | { found: false }
    | {
        found: true;
        result: MoveResult | { ok: false; reason: VaultRefusal; where: 'source' | 'destination' };
      }
  >;
  /**
   * Move one file between a plaintext and an encrypted vault, or between two encrypted ones (ROADMAP 2b.6), with the bytes the browser made for the destination.
   * `found: false` if it is not the caller's.
   */
  transfer: (
    accountId: string,
    id: number,
    input: {
      path: string;
      blob: string;
      destination: string;
      content: Uint8Array;
      author: Identity;
    },
  ) => Promise<
    | { found: false }
    | {
        found: true;
        result:
          | TransferResult
          | { ok: false; reason: VaultRefusal | 'no_encryption'; where: 'source' | 'destination' };
      }
  >;
  /** The files of a vault, for the page to convert (RFC 0003). `found: false` if the connection is not the caller's. */
  snapshot: (
    accountId: string,
    id: number,
    vault: string,
  ) => Promise<{ found: false } | { found: true; result: VaultSnapshot }>;
  /**
   * Make a whole vault encrypted or plaintext (RFC 0003), with the files the browser converted. `found: false` if it is not the caller's.
   */
  convert: (
    accountId: string,
    id: number,
    input: {
      vault: string;
      direction: 'encrypt' | 'decrypt';
      recipients: string[];
      files: ConvertedFile[];
      author: Identity;
    },
  ) => Promise<{ found: false } | { found: true; result: ConvertResult }>;
  /** Put back deletions the caller's repository has records of, at the paths they had or, for one, the one given. */
  restore: (
    accountId: string,
    id: number,
    input: { ids: number[]; path: string | undefined; author: Identity },
  ) => Promise<{ found: false } | { found: true; result: RestoreResult }>;
  /**
   * A header with its `title` set or, if it is empty, taken away (ROADMAP 1b.5), written by `fjord-core`. Nothing is read from
   * or written to the repository: the page holds the header and gets it back. `found: false` if the connection is not the
   * caller's.
   */
  header: (
    accountId: string,
    id: number,
    input: HeaderChange,
  ) => Promise<
    | { found: false }
    | {
        found: true;
        result:
          | { ok: true; header: string }
          | { ok: false; reason: 'unreadable' | 'bad_date' }
          | { ok: false; reason: 'bad_tag'; message: string };
      }
  >;
  /**
   * Make a post in one of the caller's sites (ROADMAP 3c.2): where it goes and what it says are the site's engine's, decided by the module. `found:
   * false` if it is not the caller's (or not there).
   */
  post: (
    accountId: string,
    id: number,
    input: { at: number; offsetMinutes: number; title: string; draft: boolean; author: Identity },
  ) => Promise<
    { found: false } | { found: true; result: PostResult | { ok: false; reason: SiteRefusal } }
  >;
  /**
   * Make a journal entry, dated `at` at the writer's offset, in one of the caller's plaintext journals (ROADMAP 3b.1). `found: false` if it is not
   * the caller's (or not there).
   */
  entry: (
    accountId: string,
    id: number,
    input: { at: number; offsetMinutes: number; title: string; author: Identity },
  ) => Promise<
    { found: false } | { found: true; result: EntryResult | { ok: false; reason: JournalRefusal } }
  >;
  /** The instance's origin, `FJORD_URL`. */
  origin: string;
}

const MAX_BODY_CHARS = 8_000;
const MAX_PATH_CHARS = 1_000;
const MAX_VAULT_CHARS = 255;
const CONNECTION_ID = /^[1-9][0-9]{0,15}$/;
// eslint-disable-next-line no-control-regex -- a control character is exactly what this refuses or replaces
const CONTROL = /[\u0000-\u001f\u007f]/;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
const failure = (
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) => json(status, { error: { code, message, ...extra } });
const notFound = () => failure(404, 'not_found', 'There is no such connection.');

/** `POST` makes a document, `{ vault, folder, title?, localMinute }`: one commit that adds one file. */
export async function handleCreate(
  request: Request,
  caller: Caller | null,
  deps: Deps,
  id: string,
): Promise<Response> {
  if (request.method !== 'POST')
    return failure(405, 'method_not_allowed', 'That method is not allowed here.');
  if (!caller) return failure(401, 'unauthorized', 'Sign in first.');
  if (request.headers.get('origin') !== deps.origin)
    return failure(403, 'forbidden', 'This request did not come from this site.');
  const number = CONNECTION_ID.test(id) ? Number(id) : undefined;
  if (number === undefined) return notFound();

  try {
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json'))
      return failure(415, 'unsupported_media_type', 'Send JSON.');
    const text = await request.text();
    if (text.length > MAX_BODY_CHARS)
      return failure(413, 'too_large', 'That request is too large.');
    const body = parse(text);
    if (!body) return failure(400, 'invalid_request', 'Send a JSON object.');

    const { vault, folder, title, localMinute, newFolder } = body;
    if (typeof vault !== 'string' || vault.length > MAX_VAULT_CHARS || !isRepositoryPath(vault))
      return failure(400, 'invalid_request', 'Say which vault, by its directory.');
    // What a person typed as a new folder's name (`..`, say) is a name that cannot be, not a request that is wrong.
    if (
      newFolder === true &&
      typeof folder === 'string' &&
      folder !== '' &&
      !isRepositoryPath(folder)
    )
      return failure(
        REFUSALS.bad_folder_name.status,
        'bad_folder_name',
        REFUSALS.bad_folder_name.message,
      );
    if (typeof folder !== 'string' || (folder !== '' && !isRepositoryPath(folder)))
      return failure(
        400,
        'invalid_request',
        'Say which folder of the vault, by its path, or "" for its top.',
      );
    if (
      title !== undefined &&
      title !== null &&
      (typeof title !== 'string' ||
        title.length > MAX_TITLE_CHARS ||
        CONTROL.test(title) ||
        !title.isWellFormed())
    ) {
      return failure(
        400,
        'invalid_request',
        `Send the title as one line of at most ${MAX_TITLE_CHARS} characters, or leave it out.`,
      );
    }
    const minute = readMinute(localMinute);
    if (!minute)
      return failure(
        400,
        'invalid_request',
        'Send the local date and time as whole numbers: year, month, day, hour and minute.',
      );

    if (newFolder !== undefined && typeof newFolder !== 'boolean')
      return failure(
        400,
        'invalid_request',
        'Say whether the folder is a new one with true or false, or leave it out.',
      );
    if (newFolder === true && folder === '')
      return failure(
        400,
        'invalid_request',
        'A new folder needs a name: say its path in the vault.',
      );
    const outcome = await deps.create(caller.accountId, number, {
      vault,
      folder,
      ...(newFolder === true ? { newFolder } : {}),
      title: typeof title === 'string' ? title : '',
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
 * `POST` makes a document in an **encrypted** vault, `{ vault, folder, title?, localMinute, ciphertext }` (ROADMAP 2b.4): the browser wrote the
 * file and encrypted it to the vault's recipients, and this commits those bytes as one new file. The server has no key. `ciphertext` is base64 and must begin
 * as an age file does; plain text is refused. A vault that names its files by id is sent no title (the name is inside the container; `wrong_shape` if it is), and one that names them
 * by their names is sent the title they are named by.
 */
export async function handleCreateEncrypted(
  request: Request,
  caller: Caller | null,
  deps: Deps,
  id: string,
): Promise<Response> {
  if (request.method !== 'POST')
    return failure(405, 'method_not_allowed', 'That method is not allowed here.');
  if (!caller) return failure(401, 'unauthorized', 'Sign in first.');
  if (request.headers.get('origin') !== deps.origin)
    return failure(403, 'forbidden', 'This request did not come from this site.');
  const number = CONNECTION_ID.test(id) ? Number(id) : undefined;
  if (number === undefined) return notFound();

  try {
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json'))
      return failure(415, 'unsupported_media_type', 'Send JSON.');
    const text = await request.text();
    if (text.length > MAX_ENCRYPTED_BODY_CHARS)
      return failure(413, 'too_large', 'That request is too large.');
    const body = parse(text);
    if (!body) return failure(400, 'invalid_request', 'Send a JSON object.');

    const { vault, folder, title, localMinute, ciphertext, newFolder } = body;
    if (typeof vault !== 'string' || vault.length > MAX_VAULT_CHARS || !isRepositoryPath(vault))
      return failure(400, 'invalid_request', 'Say which vault, by its directory.');
    // What a person typed as a new folder's name (`..`, say) is a name that cannot be, not a request that is wrong.
    if (
      newFolder === true &&
      typeof folder === 'string' &&
      folder !== '' &&
      !isRepositoryPath(folder)
    )
      return failure(
        REFUSALS.bad_folder_name.status,
        'bad_folder_name',
        REFUSALS.bad_folder_name.message,
      );
    if (typeof folder !== 'string' || (folder !== '' && !isRepositoryPath(folder)))
      return failure(
        400,
        'invalid_request',
        'Say which folder of the vault, by its path, or "" for its top.',
      );
    if (
      title !== undefined &&
      title !== null &&
      (typeof title !== 'string' ||
        title.length > MAX_TITLE_CHARS ||
        CONTROL.test(title) ||
        !title.isWellFormed())
    ) {
      return failure(
        400,
        'invalid_request',
        `Send the title as one line of at most ${MAX_TITLE_CHARS} characters, or leave it out.`,
      );
    }
    const minute = readMinute(localMinute);
    if (!minute)
      return failure(
        400,
        'invalid_request',
        'Send the local date and time as whole numbers: year, month, day, hour and minute.',
      );
    if (typeof ciphertext !== 'string')
      return failure(400, 'invalid_request', 'Send the encrypted file as base64 text.');
    const why = whyNotCiphertext(ciphertext);
    const bytes = why === undefined ? fromBase64(ciphertext) : undefined;
    if (
      bytes === undefined ||
      bytes.length > MAX_NEW_CIPHERTEXT_BYTES ||
      bytes.length > MAX_CIPHERTEXT_BYTES
    ) {
      return failure(
        422,
        'not_ciphertext',
        `${why ?? 'It is larger than a new file can be.'} Only an encrypted file is put into an encrypted vault.`,
      );
    }

    if (newFolder !== undefined && typeof newFolder !== 'boolean')
      return failure(
        400,
        'invalid_request',
        'Say whether the folder is a new one with true or false, or leave it out.',
      );
    if (newFolder === true && folder === '')
      return failure(
        400,
        'invalid_request',
        'A new folder needs a name: say its path in the vault.',
      );
    const outcome = await deps.createEncrypted(caller.accountId, number, {
      vault,
      folder,
      ...(newFolder === true ? { newFolder } : {}),
      title: typeof title === 'string' ? title : '',
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
/** A field's text is a line of a header: a description, a layout, a slug. */
const MAX_FIELD_CHARS = 2000;
const MAX_TAGS = 64;
const MAX_TAG_CHARS = 200;

/**
 * `POST` sets (or, with an empty title, takes away) a header's `title`: `{ header, title }` answers `{ header }`, the header
 * rewritten by the format module with every other key kept (ROADMAP 1b.5). Only the header is sent, never the body.
 */
export async function handleHeader(
  request: Request,
  caller: Caller | null,
  deps: Deps,
  id: string,
): Promise<Response> {
  if (request.method !== 'POST')
    return failure(405, 'method_not_allowed', 'That method is not allowed here.');
  if (!caller) return failure(401, 'unauthorized', 'Sign in first.');
  if (request.headers.get('origin') !== deps.origin)
    return failure(403, 'forbidden', 'This request did not come from this site.');
  const number = CONNECTION_ID.test(id) ? Number(id) : undefined;
  if (number === undefined) return notFound();

  try {
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json'))
      return failure(415, 'unsupported_media_type', 'Send JSON.');
    const text = await request.text();
    if (text.length > MAX_HEADER_CHARS + MAX_BODY_CHARS)
      return failure(413, 'too_large', 'That request is too large.');
    const body = parse(text);
    if (!body) return failure(400, 'invalid_request', 'Send a JSON object.');
    const { header, title, date, tags, field } = body;
    if (typeof header !== 'string' || header.length > MAX_HEADER_CHARS || !header.isWellFormed())
      return failure(400, 'invalid_request', 'Send the header as text.');
    // Exactly one key is changed at a time.
    const given = [title, date, tags, field].filter((value) => value !== undefined).length;
    if (given !== 1)
      return failure(
        400,
        'invalid_request',
        'Send one of the title, the date, the tags or a field to change.',
      );
    let change: HeaderChange;
    if (title !== undefined) {
      if (
        typeof title !== 'string' ||
        title.length > MAX_TITLE_CHARS ||
        CONTROL.test(title) ||
        !title.isWellFormed()
      ) {
        return failure(
          400,
          'invalid_request',
          `Send the title as one line of at most ${MAX_TITLE_CHARS} characters, or empty to take it away.`,
        );
      }
      change = { header, title };
    } else if (date !== undefined) {
      if (date !== null && (typeof date !== 'string' || date.length > 64 || CONTROL.test(date)))
        return failure(400, 'invalid_request', 'Send the date as text, or null to take it away.');
      change = { header, date };
    } else if (field !== undefined) {
      const given = field as { key?: unknown; value?: unknown } | null;
      const named = typeof given === 'object' && given !== null && !Array.isArray(given);
      const key = named ? given.key : undefined;
      const value = named ? given.value : undefined;
      if (
        typeof key !== 'string' ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(key) ||
        ['id', 'created', 'fjord'].includes(key)
      )
        return failure(
          400,
          'invalid_request',
          "Send the field's name: letters, digits, - and _, and not id, created or fjord.",
        );
      if (
        value !== null &&
        typeof value !== 'boolean' &&
        (typeof value !== 'string' ||
          value.length > MAX_FIELD_CHARS ||
          CONTROL.test(value) ||
          !value.isWellFormed())
      ) {
        return failure(
          400,
          'invalid_request',
          `Send the field's value as one line of at most ${MAX_FIELD_CHARS} characters, as true or false, or as null to take it away.`,
        );
      }
      change = { header, field: { key, value: value as string | boolean | null } };
    } else {
      if (
        !Array.isArray(tags) ||
        tags.length > MAX_TAGS ||
        !tags.every(
          (tag) =>
            typeof tag === 'string' &&
            tag !== '' &&
            tag.length <= MAX_TAG_CHARS &&
            !CONTROL.test(tag) &&
            tag.isWellFormed(),
        )
      ) {
        return failure(
          400,
          'invalid_request',
          `Send the tags as a list of at most ${MAX_TAGS}, each one line of text.`,
        );
      }
      change = { header, tags: tags as string[] };
    }
    const outcome = await deps.header(caller.accountId, number, change);
    if (!outcome.found) return notFound();
    if (outcome.result.ok) return json(200, { header: outcome.result.header });
    if (outcome.result.reason === 'bad_tag') return failure(422, 'bad_tag', outcome.result.message);
    if (outcome.result.reason === 'bad_date')
      return failure(
        422,
        'bad_date',
        'That is not a date: write it as 2026-11-02, or with a time and an offset, 2026-11-02T08:14:00+05:30.',
      );
    return failure(
      422,
      'unreadable_header',
      "This file's header cannot be read, so it cannot be changed from here.",
    );
  } catch (error) {
    return fromError(error);
  }
}

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  return undefined;
}

/** The writer's own local time, which a note with nothing to name it by is named after: real-looking whole numbers. */
function readMinute(value: unknown): LocalMinute | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { year, month, day, hour, minute } = value as Record<string, unknown>;
  const within = (n: unknown, low: number, high: number): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n >= low && n <= high;
  if (
    !within(year, 2000, 2200) ||
    !within(month, 1, 12) ||
    !within(day, 1, 31) ||
    !within(hour, 0, 23) ||
    !within(minute, 0, 59)
  )
    return undefined;
  return { year, month, day, hour, minute };
}

/** What each reason nothing was made is told as. Nothing was written, in each. */
const REFUSALS: Record<
  Extract<CreateResult, { ok: false }>['reason'] | VaultRefusal,
  { status: number; message: string }
> = {
  unknown_vault: { status: 422, message: 'This repository has no such vault.' },
  encrypted_vault: {
    status: 422,
    message: 'Files cannot be made in an encrypted vault in this version.',
  },
  unsupported_vault: {
    status: 422,
    message:
      "This vault's manifest cannot be read, or it does not use plain file names, so files cannot be made in it from here.",
  },
  folder_gone: {
    status: 409,
    message: 'That folder is no longer in the repository. Nothing was made.',
  },
  bad_folder_name: {
    status: 422,
    message:
      'That is not a name a folder can have: it cannot hold a slash, a colon or another character a file system refuses, start with a dot, end with a dot or a space, or be a name a system keeps for itself (such as CON). Nothing was made.',
  },
  folder_exists: {
    status: 409,
    message:
      'Something of that name is already there, a file or a folder (names that differ only in case are one name). Nothing was made.',
  },
  bad_title: {
    status: 422,
    message: 'A title needs some letters or digits in it to name its file by.',
  },
  head_moved: {
    status: 409,
    message: 'The repository kept changing while this was being made. Nothing was made. Try again.',
  },
  read_only: {
    status: 422,
    message:
      'That token can read this repository but not write to it, so nothing was made. Create the token with the repository permission “Contents: Read and write”, and connect the repository again.',
  },
  bad_token: {
    status: 422,
    message:
      "The git host did not accept this repository's token. Connect the repository again with a new one.",
  },
  unavailable: {
    status: 502,
    message: 'Could not reach the git host just now. Nothing was made. Try again in a moment.',
  },
};

const ENCRYPTED_REFUSALS: Record<
  Extract<CreateEncryptedResult, { ok: false }>['reason'] | EncryptedVaultRefusal | 'wrong_shape',
  { status: number; message: string }
> = {
  ...REFUSALS,
  not_encrypted: {
    status: 422,
    message: 'That vault is not encrypted. Files are made in it the ordinary way.',
  },
  unsupported_vault: {
    status: 422,
    message:
      "This vault's manifest cannot be read, or it does not use age with binary files in the container its file names need, so files cannot be made in it from here.",
  },
  wrong_shape: {
    status: 422,
    message:
      'A vault that names its files by id must not be sent the title: the name is kept inside the encrypted file.',
  },
};

/** What a person is told. An error we did not expect is logged by name, never by message, and answered plainly. */
function fromError(error: unknown): Response {
  if (isCredentialError(error, 'no_key'))
    return failure(
      503,
      'not_configured',
      'This instance cannot read repositories yet: its administrator needs to set FJORD_ENCRYPTION_KEY.',
    );
  if (isProviderError(error, 'rate_limited'))
    return failure(
      429,
      'rate_limited',
      'The git host is limiting requests. Try again in a moment.',
    );
  // A repository on this server that is at one of its account's limits (ROADMAP 3i): said in words that say what to do, and nothing was written.
  if (isProviderError(error, 'limit_reached')) return failure(409, 'limit_reached', error.message);
  console.error(`[fjord] files: unexpected ${error instanceof Error ? error.name : 'failure'}`);
  return failure(500, 'internal_error', 'Something went wrong on our side. Try again.');
}

// --- Deleting and putting back (ROADMAP 1b.12) ---------------------------------------------------------------------

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_IDS = 1000;

/** `POST` deletes `{ vault, type: "file", path, blob }` or `{ vault, type: "folder", path, files }`: one commit. */
export async function handleDelete(
  request: Request,
  caller: Caller | null,
  deps: Deps,
  id: string,
): Promise<Response> {
  const gate = await gateway(request, caller, deps, id);
  if (gate instanceof Response) return gate;

  try {
    const { body, number } = gate;
    const { vault, type, path, blob, files } = body;
    if (typeof vault !== 'string' || vault.length > MAX_VAULT_CHARS || !isRepositoryPath(vault))
      return failure(400, 'invalid_request', 'Say which vault, by its directory.');
    if (!isRepositoryPath(path))
      return failure(400, 'invalid_request', 'Say what to delete, by its path in the repository.');
    let target: DeleteTarget;
    if (type === 'file') {
      if (typeof blob !== 'string' || !OBJECT_ID.test(blob))
        return failure(
          400,
          'invalid_request',
          'Say which version of the file you were shown, by its git object id.',
        );
      target = { type: 'file', path, blob };
    } else if (type === 'folder') {
      if (typeof files !== 'number' || !Number.isInteger(files) || files < 1 || files > 1_000_000)
        return failure(
          400,
          'invalid_request',
          'Say how many files the folder holds, as you were told.',
        );
      target = { type: 'folder', path, files };
    } else {
      return failure(400, 'invalid_request', 'Say whether to delete a file or a folder.');
    }

    const outcome = await deps.delete(caller!.accountId, number, {
      vault,
      target,
      author: { name: caller!.name, email: caller!.email },
    });
    if (!outcome.found) return notFound();
    const { result } = outcome;
    if (result.ok)
      return json(200, { commit: result.commit, files: result.files, deletions: result.deletions });
    if (
      result.reason === 'unknown_vault' ||
      result.reason === 'encrypted_vault' ||
      result.reason === 'unsupported_vault'
    ) {
      const refusal = REFUSALS[result.reason];
      return failure(refusal.status, result.reason, refusal.message);
    }
    const refusal = DELETE_REFUSALS[result.reason];
    const detail = 'detail' in result ? result.detail : undefined;
    return failure(
      refusal.status,
      result.reason,
      refusal.message(detail),
      detail === undefined ? {} : { detail },
    );
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
export async function handleMove(
  request: Request,
  caller: Caller | null,
  deps: Deps,
  id: string,
): Promise<Response> {
  const gate = await gateway(request, caller, deps, id);
  if (gate instanceof Response) return gate;

  try {
    const { body, number } = gate;
    const { vault, type, path, blob, files, destination } = body;
    if (typeof vault !== 'string' || vault.length > MAX_VAULT_CHARS || !isRepositoryPath(vault))
      return failure(400, 'invalid_request', 'Say which vault, by its directory.');
    if (!isRepositoryPath(path))
      return failure(400, 'invalid_request', 'Say what to move, by its path in the repository.');
    if (
      !isRepositoryPath(destination) ||
      destination.length > MAX_PATH_CHARS ||
      !destination.isWellFormed() ||
      CONTROL.test(destination)
    ) {
      return failure(400, 'invalid_request', 'Say where it goes, by a path in the repository.');
    }
    let target: DeleteTarget;
    if (type === 'file') {
      if (typeof blob !== 'string' || !OBJECT_ID.test(blob))
        return failure(
          400,
          'invalid_request',
          'Say which version of the file you were shown, by its git object id.',
        );
      target = { type: 'file', path, blob };
    } else if (type === 'folder') {
      if (typeof files !== 'number' || !Number.isInteger(files) || files < 1 || files > 1_000_000)
        return failure(
          400,
          'invalid_request',
          'Say how many files the folder holds, as you were told.',
        );
      target = { type: 'folder', path, files };
    } else {
      return failure(400, 'invalid_request', 'Say whether to move a file or a folder.');
    }

    const outcome = await deps.move(caller!.accountId, number, {
      vault,
      target,
      destination,
      author: { name: caller!.name, email: caller!.email },
    });
    if (!outcome.found) return notFound();
    const { result } = outcome;
    if (result.ok)
      return json(200, { commit: result.commit, files: result.files, moved: result.moved });
    if (
      result.reason === 'unknown_vault' ||
      result.reason === 'encrypted_vault' ||
      result.reason === 'unsupported_vault'
    ) {
      const refusal =
        'where' in result && result.where === 'destination'
          ? MOVE_DESTINATION_REFUSALS[result.reason]
          : REFUSALS[result.reason];
      return failure(refusal.status, result.reason, refusal.message);
    }
    const refusal = MOVE_REFUSALS[result.reason];
    const detail = 'detail' in result ? result.detail : undefined;
    const taken = 'taken' in result ? result.taken : undefined;
    return failure(refusal.status, result.reason, refusal.message(detail), {
      ...(detail === undefined ? {} : { detail }),
      ...(taken === undefined ? {} : { taken }),
    });
  } catch (error) {
    return fromError(error);
  }
}

/** A transfer carries a whole file, which can be a megabyte of text. */
const MAX_TRANSFER_BODY_CHARS = Math.ceil(((1024 * 1024 + 64 * 1024) * 4) / 3) + 8_000;

/**
 * `POST` moves one file between vaults when one of them is encrypted, `{ path, blob, destination, content }` (ROADMAP 2b.6): the browser decrypted or encrypted the file on the way, and
 * `content` (base64) is what belongs at `destination`. One commit takes the source away and adds the destination. The server has no key, so it checks what it can: the
 * source is still the blob that was shown, the bytes are the form the destination vault holds (age in an encrypted one, text in a plaintext one), the name is valid, and
 * nothing is put over anything.
 */
export async function handleTransfer(
  request: Request,
  caller: Caller | null,
  deps: Deps,
  id: string,
): Promise<Response> {
  if (request.method !== 'POST')
    return failure(405, 'method_not_allowed', 'That method is not allowed here.');
  if (!caller) return failure(401, 'unauthorized', 'Sign in first.');
  if (request.headers.get('origin') !== deps.origin)
    return failure(403, 'forbidden', 'This request did not come from this site.');
  const number = CONNECTION_ID.test(id) ? Number(id) : undefined;
  if (number === undefined) return notFound();

  try {
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json'))
      return failure(415, 'unsupported_media_type', 'Send JSON.');
    const text = await request.text();
    if (text.length > MAX_TRANSFER_BODY_CHARS)
      return failure(413, 'too_large', 'That request is too large.');
    const body = parse(text);
    if (!body) return failure(400, 'invalid_request', 'Send a JSON object.');
    const { path, blob, destination, content } = body;
    if (!isRepositoryPath(path))
      return failure(400, 'invalid_request', 'Say what to move, by its path in the repository.');
    if (typeof blob !== 'string' || !OBJECT_ID.test(blob))
      return failure(
        400,
        'invalid_request',
        'Say which version of the file you were shown, by its git object id.',
      );
    if (
      !isRepositoryPath(destination) ||
      destination.length > MAX_PATH_CHARS ||
      !destination.isWellFormed() ||
      CONTROL.test(destination)
    ) {
      return failure(400, 'invalid_request', 'Say where it goes, by a path in the repository.');
    }
    if (
      typeof content !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)
    )
      return failure(400, 'invalid_request', 'Send the file as base64 text.');
    const bytes = new Uint8Array(Buffer.from(content, 'base64'));
    if (bytes.length > 1024 * 1024 + 64 * 1024)
      return failure(413, 'too_large', 'That file is too large to move from here.');

    const outcome = await deps.transfer(caller.accountId, number, {
      path,
      blob,
      destination,
      content: bytes,
      author: { name: caller.name, email: caller.email },
    });
    if (!outcome.found) return notFound();
    const { result } = outcome;
    if (result.ok) return json(200, { commit: result.commit, path: result.path });
    if (result.reason === 'no_encryption')
      return failure(422, 'no_encryption', 'Neither vault is encrypted: move it the ordinary way.');
    if (
      result.reason === 'unknown_vault' ||
      result.reason === 'encrypted_vault' ||
      result.reason === 'unsupported_vault'
    ) {
      const refusal = MOVE_DESTINATION_REFUSALS[result.reason];
      return failure(
        refusal.status,
        result.reason,
        'where' in result && result.where === 'source'
          ? REFUSALS[result.reason].message
          : refusal.message,
      );
    }
    const refusal = TRANSFER_REFUSALS[result.reason];
    return failure(
      refusal.status,
      result.reason,
      refusal.message,
      'taken' in result && result.taken ? { taken: result.taken } : {},
    );
  } catch (error) {
    return fromError(error);
  }
}

/** A conversion carries every file of a vault, twice (what it was and what it is), as base64. */
const MAX_CONVERT_FILES = 300;
const MAX_CONVERT_BODY_CHARS = 48 * 1024 * 1024;
const MAX_CONVERT_FILE_BYTES = 8 * 1024 * 1024;

/**
 * `POST` makes a vault encrypted or plaintext, `{ vault, direction, recipients?, files: [{ path, blob, to, content }] }` (RFC 0003): the browser encrypted or decrypted each file, and
 * `content` (base64) is what belongs at `to`. One commit holds all of it with the vault's new manifest, which is `fjord-core`'s and not the page's. The server has no key, so it checks
 * what it can: every file of the vault is there and still the blob that was shown, the bytes are the form the vault will hold, and nothing is put over anything.
 */
export async function handleConvert(
  request: Request,
  caller: Caller | null,
  deps: Deps,
  id: string,
): Promise<Response> {
  if (request.method !== 'POST')
    return failure(405, 'method_not_allowed', 'That method is not allowed here.');
  if (!caller) return failure(401, 'unauthorized', 'Sign in first.');
  if (request.headers.get('origin') !== deps.origin)
    return failure(403, 'forbidden', 'This request did not come from this site.');
  const number = CONNECTION_ID.test(id) ? Number(id) : undefined;
  if (number === undefined) return notFound();

  try {
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json'))
      return failure(415, 'unsupported_media_type', 'Send JSON.');
    const text = await request.text();
    if (text.length > MAX_CONVERT_BODY_CHARS)
      return failure(
        413,
        'too_large',
        'That vault is too large to convert from here. Use `fjord encrypt <vault> --permanent` or `fjord decrypt <vault> --permanent`.',
      );
    const body = parse(text);
    if (!body) return failure(400, 'invalid_request', 'Send a JSON object.');
    const { vault, direction, recipients, files } = body;
    if (
      typeof vault !== 'string' ||
      vault === '' ||
      vault.includes('/') ||
      !isRepositoryPath(vault)
    )
      return failure(400, 'invalid_request', 'Say which vault, by its directory.');
    if (direction !== 'encrypt' && direction !== 'decrypt')
      return failure(400, 'invalid_request', 'Say whether to encrypt or decrypt.');
    const keys = recipients === undefined ? [] : recipients;
    if (
      !Array.isArray(keys) ||
      keys.length > 100 ||
      keys.some((key) => typeof key !== 'string' || key.length > 200)
    )
      return failure(400, 'invalid_request', 'Send the recipients as a list of age public keys.');
    if (!Array.isArray(files) || files.length > MAX_CONVERT_FILES)
      return failure(
        413,
        'too_large',
        'That vault has too many files to convert from here. Use the command line.',
      );
    const converted: ConvertedFile[] = [];
    for (const file of files) {
      const entry = file as Record<string, unknown> | null;
      if (
        !entry ||
        typeof entry !== 'object' ||
        !isRepositoryPath(entry.path) ||
        !isRepositoryPath(entry.to) ||
        (entry.to as string).length > MAX_PATH_CHARS ||
        !(entry.to as string).isWellFormed() ||
        CONTROL.test(entry.to as string)
      ) {
        return failure(
          400,
          'invalid_request',
          'Each file needs the path it has and the path it will have.',
        );
      }
      if (typeof entry.blob !== 'string' || !OBJECT_ID.test(entry.blob))
        return failure(
          400,
          'invalid_request',
          'Say which version of each file you were shown, by its git object id.',
        );
      if (
        typeof entry.content !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.content)
      )
        return failure(400, 'invalid_request', 'Send each file as base64 text.');
      const bytes = new Uint8Array(Buffer.from(entry.content, 'base64'));
      if (bytes.length > MAX_CONVERT_FILE_BYTES)
        return failure(
          413,
          'too_large',
          'A file in that vault is too large to convert from here. Use the command line.',
        );
      converted.push({
        path: entry.path as string,
        blob: entry.blob,
        to: entry.to as string,
        content: bytes,
      });
    }

    const outcome = await deps.convert(caller.accountId, number, {
      vault,
      direction,
      recipients: keys as string[],
      files: converted,
      author: { name: caller.name, email: caller.email },
    });
    if (!outcome.found) return notFound();
    const { result } = outcome;
    if (result.ok) return json(200, { commit: result.commit, files: result.files.length });
    const refusal = CONVERT_REFUSALS[result.reason];
    return failure(
      refusal.status,
      result.reason,
      result.message && refusal.status === 422
        ? `${refusal.message} ${result.message}`
        : refusal.message,
      result.paths ? { paths: result.paths.slice(0, 20) } : {},
    );
  } catch (error) {
    return fromError(error);
  }
}

/** `GET ?vault=<directory>`: the vault's files, as base64 with the blob each is of, for the page to encrypt or decrypt (RFC 0003). Read-only. */
export async function handleConvertSource(
  request: Request,
  caller: Caller | null,
  deps: Deps,
  id: string,
): Promise<Response> {
  if (request.method !== 'GET')
    return failure(405, 'method_not_allowed', 'That method is not allowed here.');
  if (!caller) return failure(401, 'unauthorized', 'Sign in first.');
  const number = CONNECTION_ID.test(id) ? Number(id) : undefined;
  if (number === undefined) return notFound();
  const vault = new URL(request.url).searchParams.get('vault');
  if (!vault || vault.includes('/') || !isRepositoryPath(vault))
    return failure(400, 'invalid_request', 'Say which vault, by its directory.');
  try {
    const outcome = await deps.snapshot(caller.accountId, number, vault);
    if (!outcome.found) return notFound();
    const { result } = outcome;
    if (!result.ok) {
      const refusal = CONVERT_REFUSALS[result.reason];
      return failure(refusal.status, result.reason, refusal.message);
    }
    return new Response(
      JSON.stringify({
        encrypted: result.encrypted,
        naming: result.naming,
        files: result.files.map((file) => ({
          path: file.path,
          blob: file.blob,
          content: Buffer.from(file.content).toString('base64'),
        })),
      }),
      { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
    );
  } catch (error) {
    return fromError(error);
  }
}

const CONVERT_REFUSALS: Record<
  Extract<ConvertResult, { ok: false }>['reason'],
  { status: number; message: string }
> = {
  gone: {
    status: 404,
    message: 'That vault is not in the repository any more. Nothing was changed.',
  },
  site: { status: 422, message: "A site's content is never encrypted: it is published." },
  too_large: {
    status: 413,
    message:
      'That vault, or a file in it, is too large to convert from here. Use `fjord encrypt <vault> --permanent` or `fjord decrypt <vault> --permanent`.',
  },
  too_many: {
    status: 413,
    message:
      'That vault has too many files to convert from here. Use `fjord encrypt <vault> --permanent` or `fjord decrypt <vault> --permanent`.',
  },
  upstream_changed: {
    status: 409,
    message:
      'A file in that vault changed in the repository after you looked at it. Nothing was changed. Try again.',
  },
  missing_files: {
    status: 409,
    message:
      "The vault's files are not the ones that were converted: some were added or removed in the repository. Nothing was changed. Try again.",
  },
  has_drafts: {
    status: 409,
    message:
      'A file in that vault has unsaved changes. Save a version of them, or discard them, first. Nothing was changed.',
  },
  bad_path: {
    status: 422,
    message: 'A file was not given a name it can have there. Nothing was changed.',
  },
  wrong_form: {
    status: 422,
    message:
      'What was sent is not the form the vault will hold: an encrypted vault takes only encrypted files, and a plaintext one only files that are not. Nothing was changed.',
  },
  path_taken: {
    status: 409,
    message:
      'A converted file would land on a name that is taken, or differs from one only by letter case. Nothing was changed.',
  },
  head_moved: {
    status: 409,
    message:
      'The repository kept changing while this was being done. Nothing was changed. Try again.',
  },
  read_only: {
    status: 422,
    message:
      'That token can read this repository but not write to it, so nothing was changed. Create the token with the repository permission “Contents: Read and write”, and connect the repository again.',
  },
  bad_token: {
    status: 422,
    message:
      "The git host did not accept this repository's token. Connect the repository again with a new one.",
  },
  unavailable: {
    status: 502,
    message: 'Could not reach the git host just now. Nothing was changed. Try again in a moment.',
  },
  manifest_unusable: {
    status: 422,
    message: "That vault's manifest cannot be read, so it was not changed.",
  },
  already_encrypted: { status: 409, message: 'That vault is already encrypted.' },
  not_encrypted: { status: 409, message: 'That vault is not encrypted.' },
  no_recipients: {
    status: 422,
    message:
      'There is no one to encrypt to: an encrypted vault with no recipients could be written by nobody.',
  },
  bad_recipient: { status: 422, message: 'One of the recipients is not a usable age public key.' },
};

const TRANSFER_REFUSALS: Record<
  Extract<TransferResult, { ok: false }>['reason'],
  { status: number; message: string }
> = {
  gone: { status: 409, message: 'That is no longer in the repository. Nothing was moved.' },
  upstream_changed: {
    status: 409,
    message:
      'That file changed in the repository after you looked at it, so it was not moved. Look at it again.',
  },
  has_drafts: {
    status: 409,
    message:
      'This file, or a place it is going to, has unsaved changes. Save a version of them, or discard them, first. Nothing was moved.',
  },
  bad_path: {
    status: 422,
    message:
      'That is not a name or a place a file can have there. Names cannot hold characters such as : ? * or /, end in a space or a dot, or be one Windows reserves; a plaintext vault takes .md files.',
  },
  protected: {
    status: 422,
    message: "A vault, its manifest and the repository's own files cannot be moved from here.",
  },
  wrong_form: {
    status: 422,
    message:
      'What was sent is not the form the vault it goes to holds: an encrypted vault takes only encrypted files, and a plaintext one only text. Nothing was moved.',
  },
  path_taken: {
    status: 409,
    message:
      'Something is at that name already, or has a name like it that differs only by letter case. Nothing was moved and nothing was replaced. Choose another name.',
  },
  same_vault: { status: 422, message: 'That is the same vault: use Move.' },
  head_moved: {
    status: 409,
    message:
      'The repository kept changing while this was being moved. Nothing was moved. Try again.',
  },
  read_only: {
    status: 422,
    message:
      'That token can read this repository but not write to it, so nothing was moved. Create the token with the repository permission “Contents: Read and write”, and connect the repository again.',
  },
  bad_token: {
    status: 422,
    message:
      "The git host did not accept this repository's token. Connect the repository again with a new one.",
  },
  unavailable: {
    status: 502,
    message: 'Could not reach the git host just now. Nothing was moved. Try again in a moment.',
  },
};

/** `POST` puts back what was deleted, `{ ids: [deletion ids], path? }`: one commit, never over anything. */
export async function handleRestore(
  request: Request,
  caller: Caller | null,
  deps: Deps,
  id: string,
): Promise<Response> {
  const gate = await gateway(request, caller, deps, id);
  if (gate instanceof Response) return gate;

  try {
    const { body, number } = gate;
    const { ids, path } = body;
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > MAX_IDS ||
      !ids.every((value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    ) {
      return failure(400, 'invalid_request', 'Say which deletions to put back, by their numbers.');
    }
    if (path !== undefined && path !== null && !isRepositoryPath(path))
      return failure(
        400,
        'invalid_request',
        'Say where to put it, by a path in the repository, or leave it out.',
      );

    const outcome = await deps.restore(caller!.accountId, number, {
      ids: ids as number[],
      path: typeof path === 'string' ? path : undefined,
      author: { name: caller!.name, email: caller!.email },
    });
    if (!outcome.found) return notFound();
    const { result } = outcome;
    if (result.ok) return json(200, { commit: result.commit, paths: result.paths });
    const refusal = RESTORE_REFUSALS[result.reason];
    return failure(
      refusal.status,
      result.reason,
      refusal.message,
      result.taken ? { taken: result.taken } : {},
    );
  } catch (error) {
    return fromError(error);
  }
}

/** What every write has to be, before its body is looked at: a POST, a signed-in caller, this site, a connection id, JSON. */
async function gateway(
  request: Request,
  caller: Caller | null,
  deps: Deps,
  id: string,
): Promise<Response | { body: Record<string, unknown>; number: number }> {
  if (request.method !== 'POST')
    return failure(405, 'method_not_allowed', 'That method is not allowed here.');
  if (!caller) return failure(401, 'unauthorized', 'Sign in first.');
  if (request.headers.get('origin') !== deps.origin)
    return failure(403, 'forbidden', 'This request did not come from this site.');
  const number = CONNECTION_ID.test(id) ? Number(id) : undefined;
  if (number === undefined) return notFound();
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json'))
    return failure(415, 'unsupported_media_type', 'Send JSON.');
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return failure(413, 'too_large', 'That request is too large.');
  const body = parse(text);
  return body ? { body, number } : failure(400, 'invalid_request', 'Send a JSON object.');
}

/** What each reason nothing was deleted is told as. Nothing was written, and nothing recorded, in each. */
const DELETE_REFUSALS: Record<
  Extract<DeleteResult, { ok: false }>['reason'],
  { status: number; message: (detail: number | string | undefined) => string }
> = {
  gone: { status: 409, message: () => 'That is no longer in the repository. Nothing was deleted.' },
  upstream_changed: {
    status: 409,
    message: () =>
      'That note changed in the repository after you looked at it, so it was not deleted. Look at it again.',
  },
  folder_changed: {
    status: 409,
    message: (detail) =>
      `That folder now holds ${typeof detail === 'number' ? detail : 'a different number of'} files, not the number you were told, so nothing was deleted. Look at it again.`,
  },
  too_many: {
    status: 422,
    message: () =>
      'That folder holds too many files to delete from here. Delete it from the command line, or in smaller parts.',
  },
  has_drafts: {
    status: 409,
    message: (detail) =>
      `${detail ?? 'Some'} of the files in that folder have unsaved changes. Save a version of each, or discard the changes, first. Nothing was deleted.`,
  },
  draft_not_saved: {
    status: 409,
    message: () =>
      'This note has unsaved changes, and they could not be saved as a version first, so it was not deleted. Open it and save a version, or discard the changes.',
  },
  protected: {
    status: 422,
    message: () =>
      "A vault, its manifest and the repository's own files cannot be deleted from here.",
  },
  head_moved: {
    status: 409,
    message: () =>
      'The repository kept changing while this was being deleted. Nothing was deleted. Try again.',
  },
  read_only: {
    status: 422,
    message: () =>
      'That token can read this repository but not write to it, so nothing was deleted. Create the token with the repository permission “Contents: Read and write”, and connect the repository again.',
  },
  bad_token: {
    status: 422,
    message: () =>
      "The git host did not accept this repository's token. Connect the repository again with a new one.",
  },
  unavailable: {
    status: 502,
    message: () =>
      'Could not reach the git host just now. Nothing was deleted. Try again in a moment.',
  },
};

/** What each reason nothing was moved is told as. Nothing was written in each. */
const MOVE_REFUSALS: Record<
  Extract<MoveResult, { ok: false }>['reason'],
  { status: number; message: (detail: number | string | undefined) => string }
> = {
  gone: { status: 409, message: () => 'That is no longer in the repository. Nothing was moved.' },
  upstream_changed: {
    status: 409,
    message: () =>
      'That note changed in the repository after you looked at it, so it was not moved. Look at it again.',
  },
  folder_changed: {
    status: 409,
    message: (detail) =>
      `That folder now holds ${typeof detail === 'number' ? detail : 'a different number of'} files, not the number you were told, so nothing was moved. Look at it again.`,
  },
  too_many: {
    status: 422,
    message: () =>
      'That folder holds too many files to move from here. Move it from the command line, or in smaller parts.',
  },
  has_drafts: {
    status: 409,
    message: (detail) =>
      `${detail ?? 'Some'} of the files in that folder have unsaved changes. Save a version of each, or discard the changes, first. Nothing was moved.`,
  },
  draft_not_saved: {
    status: 409,
    message: () =>
      'This note has unsaved changes, and they could not be saved as a version first, so it was not moved. Open it and save a version, or discard the changes.',
  },
  protected: {
    status: 422,
    message: () =>
      "A vault, its manifest and the repository's own files cannot be renamed or moved from here.",
  },
  bad_path: {
    status: 422,
    message: () =>
      'That is not a name or a place a file can have here. Names cannot hold characters such as : ? * or /, end in a space or a dot, or be one Windows reserves.',
  },
  extension_changed: {
    status: 422,
    message: () =>
      "A rename keeps the file's extension: a .md stays a .md (and an encrypted file keeps its .age).",
  },
  id_named: {
    status: 422,
    message: () =>
      'This vault names its files by identifier, which never changes. A file in it is renamed by changing the name kept inside it, which only your browser can do, with your identity.',
  },
  other_vault: {
    status: 422,
    message: () =>
      "A file does not leave an encrypted vault this way: it has to be decrypted first. Use Move to another vault on the file's page, which does that in your browser.",
  },
  into_itself: { status: 422, message: () => 'A folder cannot be moved into itself.' },
  unchanged: { status: 422, message: () => 'That is where it is already.' },
  path_taken: {
    status: 409,
    message: () =>
      'Something is at that name already, or has a name like it that differs only by letter case. Nothing was moved and nothing was replaced. Choose another name.',
  },
  head_moved: {
    status: 409,
    message: () =>
      'The repository kept changing while this was being moved. Nothing was moved. Try again.',
  },
  read_only: {
    status: 422,
    message: () =>
      'That token can read this repository but not write to it, so nothing was moved. Create the token with the repository permission “Contents: Read and write”, and connect the repository again.',
  },
  bad_token: {
    status: 422,
    message: () =>
      "The git host did not accept this repository's token. Connect the repository again with a new one.",
  },
  unavailable: {
    status: 502,
    message: () =>
      'Could not reach the git host just now. Nothing was moved. Try again in a moment.',
  },
};

/** The vault something is going to, when that is what is wrong. */
const MOVE_DESTINATION_REFUSALS: Record<VaultRefusal, { status: number; message: string }> = {
  unknown_vault: { status: 422, message: 'This repository has no such vault to move it to.' },
  encrypted_vault: {
    status: 422,
    message:
      "A file does not move into an encrypted vault this way: it would put plaintext in it. Use Move to another vault on the file's page, which encrypts it in your browser first.",
  },
  unsupported_vault: {
    status: 422,
    message:
      "That vault's manifest cannot be read, or it does not use plain file names, so nothing can be moved into it from here.",
  },
};

/** What each reason nothing was put back is told as. Nothing was written in each, and what is there is untouched. */
const RESTORE_REFUSALS: Record<
  Extract<RestoreResult, { ok: false }>['reason'],
  { status: number; message: string }
> = {
  not_found: { status: 404, message: 'There is no such deletion.' },
  already_restored: { status: 409, message: 'That has been put back already.' },
  expired: {
    status: 409,
    message:
      "That was deleted too long ago to be offered here. It is still in the repository's history.",
  },
  bad_path: {
    status: 422,
    message:
      'That is not a place it can be put back: the name is not a valid one, it must stay in a vault and keep its kind of file, and only one file can be given a place.',
  },
  vault_unavailable: {
    status: 422,
    message:
      'Its vault can no longer be written to from here (it is gone, encrypted or not one this version writes).',
  },
  path_taken: {
    status: 409,
    message:
      'Something is already at that path, or in the way of it, so nothing was put back. Choose another place.',
  },
  id_taken: {
    status: 409,
    message:
      'A file in the repository already has the id of what you are putting back, so putting it back would make two documents of one. Nothing was put back. The files that have it are listed; delete or change one of them first.',
  },
  blob_gone: {
    status: 422,
    message:
      "The repository no longer has this file's content in its history, so it cannot be put back from here.",
  },
  head_moved: {
    status: 409,
    message:
      'The repository kept changing while this was being put back. Nothing was changed. Try again.',
  },
  read_only: {
    status: 422,
    message: 'That token can read this repository but not write to it, so nothing was put back.',
  },
  bad_token: {
    status: 422,
    message:
      "The git host did not accept this repository's token. Connect the repository again with a new one.",
  },
  unavailable: {
    status: 502,
    message: 'Could not reach the git host just now. Nothing was put back. Try again in a moment.',
  },
};

// --- Journal entries (ROADMAP 3b.1) ---------------------------------------------------------------------------------

/**
 * `POST` makes an entry in one of the caller's plaintext journals, `{ at, offsetMinutes, title? }`: the moment, and the writer's offset from UTC
 * in minutes, which the entry's `date` keeps (spec §8.1). One commit; where it goes and what it says are `fjord-core`'s.
 */
export async function handleEntry(
  request: Request,
  caller: Caller | null,
  deps: Deps,
  id: string,
): Promise<Response> {
  const gate = await gateway(request, caller, deps, id);
  if (gate instanceof Response) return gate;
  try {
    const { body, number } = gate;
    const { at, offsetMinutes, title } = body;
    if (typeof at !== 'number' || !Number.isInteger(at) || at < 0)
      return failure(400, 'invalid_request', 'Send the moment as milliseconds since 1970.');
    if (
      typeof offsetMinutes !== 'number' ||
      !Number.isInteger(offsetMinutes) ||
      Math.abs(offsetMinutes) >= 24 * 60
    )
      return failure(400, 'invalid_request', 'Send your offset from UTC in whole minutes.');
    if (
      title !== undefined &&
      title !== null &&
      (typeof title !== 'string' ||
        title.length > MAX_TITLE_CHARS ||
        CONTROL.test(title) ||
        !title.isWellFormed())
    ) {
      return failure(
        400,
        'invalid_request',
        `Send the title as one line of at most ${MAX_TITLE_CHARS} characters, or leave it out.`,
      );
    }
    const outcome = await deps.entry((caller as Caller).accountId, number, {
      at,
      offsetMinutes,
      title: typeof title === 'string' ? title : '',
      author: { name: (caller as Caller).name, email: (caller as Caller).email },
    });
    if (!outcome.found) return notFound();
    const { result } = outcome;
    if (result.ok)
      return json(201, { path: result.path, commit: result.commit, date: result.date });
    const refusal = ENTRY_REFUSALS[result.reason];
    return failure(refusal.status, result.reason, refusal.message);
  } catch (error) {
    return fromError(error);
  }
}

// --- Giving a Doc an identifier (ROADMAP 3e.3) ---------------------------------------------------------------------

/** `POST` gives a Doc an identifier, `{ path, blob }`: the file, and the version of it the person looked at. One commit, or none when it has one. */
export async function handleIdentify(
  request: Request,
  caller: Caller | null,
  deps: Deps,
  id: string,
): Promise<Response> {
  const gate = await gateway(request, caller, deps, id);
  if (gate instanceof Response) return gate;
  try {
    const { body, number } = gate;
    const { path, blob } = body;
    if (
      typeof path !== 'string' ||
      path.length > MAX_PATH_CHARS ||
      !isRepositoryPath(path) ||
      !path.includes('/')
    )
      return failure(400, 'invalid_request', 'Say which file, by its path.');
    if (typeof blob !== 'string' || !/^[0-9a-f]{40}$/.test(blob))
      return failure(400, 'invalid_request', 'Say which version of it you looked at.');
    const outcome = await deps.identify((caller as Caller).accountId, number, {
      path,
      blob,
      author: { name: (caller as Caller).name, email: (caller as Caller).email },
    });
    if (!outcome.found) return notFound();
    const { result } = outcome;
    if (result.ok) return json(200, { docId: result.docId, commit: result.commit });
    const refusal = IDENTIFY_REFUSALS[result.reason];
    return failure(refusal.status, result.reason, refusal.message);
  } catch (error) {
    return fromError(error);
  }
}

const IDENTIFY_REFUSALS: Record<
  Extract<IdentifyResult, { ok: false }>['reason'] | VaultRefusal,
  { status: number; message: string }
> = {
  gone: { status: 409, message: 'That file is no longer in the repository. Nothing was changed.' },
  changed: {
    status: 409,
    message:
      'That file changed in the repository after you looked at it, so nothing was changed. Look at it again.',
  },
  not_markdown: { status: 422, message: 'Only a Markdown file can be given an identifier.' },
  too_large: {
    status: 422,
    message: 'That file is too large to be given an identifier from here.',
  },
  not_text: { status: 422, message: 'That file is not text, so it cannot be given an identifier.' },
  cannot_identify: {
    status: 422,
    message:
      "That file's header cannot be added to from here: it cannot be read, or the file has Windows line endings or a byte-order mark that a new header would disturb. Nothing was changed.",
  },
  unknown_vault: { status: 404, message: 'That vault is not in the repository.' },
  encrypted_vault: {
    status: 422,
    message: 'A file in an encrypted vault is not read here: its identifier is inside it.',
  },
  unsupported_vault: {
    status: 422,
    message:
      'That vault cannot be written to from here: its manifest cannot be read, or its files are not named plainly.',
  },
  head_moved: REFUSALS.head_moved,
  read_only: REFUSALS.read_only,
  bad_token: REFUSALS.bad_token,
  unavailable: REFUSALS.unavailable,
};

const ENTRY_REFUSALS: Record<
  Extract<EntryResult, { ok: false }>['reason'] | JournalRefusal,
  { status: number; message: string }
> = {
  not_a_journal: {
    status: 422,
    message: 'This repository is not a journal with one vault, so it has no entries to add to.',
  },
  encrypted_journal: {
    status: 422,
    message:
      'This journal is encrypted: its entries are written and encrypted in your browser, not here.',
  },
  unsupported_journal: {
    status: 422,
    message:
      "This journal's vault cannot be written to from here: its manifest cannot be read, or its files are not named plainly.",
  },
  bad_date: { status: 422, message: 'That moment cannot be written as a date.' },
  head_moved: REFUSALS.head_moved,
  read_only: REFUSALS.read_only,
  bad_token: REFUSALS.bad_token,
  unavailable: REFUSALS.unavailable,
};

// --- A site's new post (ROADMAP 3c.2) -------------------------------------------------------------------------------

/**
 * `POST` makes a post in one of the caller's sites, `{ at, offsetMinutes, title?, draft? }`: the moment, the writer's offset from UTC in minutes
 * and whether it is a draft. One commit; where it goes and what it says are the engine's, which the module knows (spec §3.1).
 */
export async function handlePost(
  request: Request,
  caller: Caller | null,
  deps: Deps,
  id: string,
): Promise<Response> {
  const gate = await gateway(request, caller, deps, id);
  if (gate instanceof Response) return gate;
  try {
    const { body, number } = gate;
    const { at, offsetMinutes, title, draft } = body;
    if (typeof at !== 'number' || !Number.isInteger(at) || at < 0)
      return failure(400, 'invalid_request', 'Send the moment as milliseconds since 1970.');
    if (
      typeof offsetMinutes !== 'number' ||
      !Number.isInteger(offsetMinutes) ||
      Math.abs(offsetMinutes) >= 24 * 60
    )
      return failure(400, 'invalid_request', 'Send your offset from UTC in whole minutes.');
    if (draft !== undefined && typeof draft !== 'boolean')
      return failure(400, 'invalid_request', 'Say whether it is a draft with true or false.');
    if (
      title !== undefined &&
      title !== null &&
      (typeof title !== 'string' ||
        title.length > MAX_TITLE_CHARS ||
        CONTROL.test(title) ||
        !title.isWellFormed())
    ) {
      return failure(
        400,
        'invalid_request',
        `Send the title as one line of at most ${MAX_TITLE_CHARS} characters, or leave it out.`,
      );
    }
    const outcome = await deps.post((caller as Caller).accountId, number, {
      at,
      offsetMinutes,
      title: typeof title === 'string' ? title : '',
      draft: draft === true,
      author: { name: (caller as Caller).name, email: (caller as Caller).email },
    });
    if (!outcome.found) return notFound();
    const { result } = outcome;
    if (result.ok)
      return json(201, { path: result.path, commit: result.commit, date: result.date });
    const refusal = POST_REFUSALS[result.reason];
    return failure(refusal.status, result.reason, refusal.message);
  } catch (error) {
    return fromError(error);
  }
}

const POST_REFUSALS: Record<
  Extract<PostResult, { ok: false }>['reason'] | SiteRefusal,
  { status: number; message: string }
> = {
  not_a_site: {
    status: 422,
    message: 'This repository is not a site with one vault, so it has no posts to add to.',
  },
  unknown_engine: {
    status: 422,
    message:
      "This site's engine is not one this version knows (Astro or Jekyll), so it does not know where a post goes.",
  },
  unsupported_site: {
    status: 422,
    message:
      "This site's vault cannot be written to from here: its manifest cannot be read, it is encrypted, or its files are not named plainly.",
  },
  draft_not_here: {
    status: 422,
    message:
      'This site keeps its posts in the Jekyll folder `_posts`, and a draft goes in `_drafts`, beside it and outside what Fjord manages. Make it a post, or write the draft there yourself.',
  },
  bad_date: { status: 422, message: 'That moment cannot be written as a date.' },
  head_moved: REFUSALS.head_moved,
  read_only: REFUSALS.read_only,
  bad_token: REFUSALS.bad_token,
  unavailable: REFUSALS.unavailable,
};
