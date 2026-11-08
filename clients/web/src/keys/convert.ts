import type { CryptoModule } from './module';
import { KeyError } from './store';
import { fromBase64, toBase64 } from './files';

/**
 * Converting every file of a vault, in the browser (RFC 0003). The server has no key, so this is where the files change form: each is read as the bytes it is, and, to encrypt, sealed to the
 * recipients and **opened again with the identity to prove it is the file it was made from** before anything is sent (the browser's counterpart of the CLI's check, spec §6.6 (8)); to decrypt,
 * opened with the identity. Plaintext buffers are wiped as soon as they are ciphertext or are sent. The module and the lent identity are given, so this is tested with the real module and no page.
 */
export interface SnapshotFile {
  path: string;
  blob: string;
  /** base64, as the server hands it over. */
  content: string;
}

/** A file as the server is given it: what it was (`path`, `blob`), where it goes (`to`), and its bytes (`content`, base64). */
export interface ToSend {
  path: string;
  blob: string;
  to: string;
  content: string;
}

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, at) => value === b[at]);
const folderOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);

/** Every file sealed to `recipients` (the text of a recipients file) as `<name>.age`, and each opened again to prove it. */
export function encryptFiles(
  module: CryptoModule,
  keys: { with<T>(use: (secret: Uint8Array) => T): T },
  input: { files: SnapshotFile[]; recipients: string },
): ToSend[] {
  return input.files.map((file) => {
    const plain = fromBase64(file.content);
    try {
      const sealed = module.encrypt(plain, input.recipients, false);
      let opened: Uint8Array | undefined;
      try {
        opened = keys.with((secret) => module.decrypt(sealed, secret));
      } catch (error) {
        if (error instanceof KeyError) throw error;
        throw new KeyError(
          'unreadable',
          'This identity cannot open what was just encrypted, so it is not one of the recipients. Nothing was changed.',
        );
      }
      const matches = same(opened, plain);
      opened.fill(0);
      if (!matches)
        throw new KeyError(
          'unreadable',
          'A file did not decrypt to what it was made from, so nothing was changed.',
        );
      return {
        path: file.path,
        blob: file.blob,
        to: `${file.path}.age`,
        content: toBase64(sealed),
      };
    } finally {
      plain.fill(0);
    }
  });
}

/** Every payload opened with the identity: `<name>.age` becomes `<name>`, and in an `id`-named vault the name inside the container is the name. */
export function decryptFiles(
  module: CryptoModule,
  keys: { with<T>(use: (secret: Uint8Array) => T): T },
  input: { files: SnapshotFile[]; naming: 'plain' | 'id' },
): ToSend[] {
  return input.files.map((file) => {
    const sealed = fromBase64(file.content);
    let plain: Uint8Array;
    try {
      plain = keys.with((secret) => module.decrypt(sealed, secret));
    } catch (error) {
      if (error instanceof KeyError) throw error;
      throw new KeyError(
        'unreadable',
        'This identity cannot open a file of the vault: it is not one of the keys it was encrypted to, or the file is damaged. Nothing was changed.',
      );
    }
    try {
      if (input.naming === 'id') {
        const unwrapped = module.unwrapContainer(plain);
        try {
          return {
            path: file.path,
            blob: file.blob,
            to: `${folderOf(file.path)}${unwrapped.name}`,
            content: toBase64(unwrapped.contents),
          };
        } finally {
          unwrapped.contents.fill(0);
        }
      }
      if (!file.path.endsWith('.age'))
        throw new KeyError(
          'unreadable',
          'A file of the vault is not an encrypted payload. Nothing was changed.',
        );
      return {
        path: file.path,
        blob: file.blob,
        to: file.path.slice(0, -4),
        content: toBase64(plain),
      };
    } finally {
      plain.fill(0);
    }
  });
}
