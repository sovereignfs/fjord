/**
 * The encryption half of the format module, as a page uses it (ROADMAP 2a): the same WebAssembly module the server loads
 * (`crates/fjord-wasm`, with `age` since P8), served as a file of this origin at `/fjord-wasm/` and loaded the first time a page needs to
 * encrypt or decrypt, not before: it is about 400 KB gzipped, which a page that never opens an encrypted file should not pay.
 *
 * Secrets cross the boundary as `Uint8Array`s, so the code that holds one can wipe it (`fill(0)`) when it is done.
 */
export interface CryptoModule {
  generateIdentity(): Uint8Array;
  identityRecipient(identity: Uint8Array): string;
  checkRecipient(text: string): string | undefined;
  isWellFormed(bytes: Uint8Array): boolean;
  encrypt(plaintext: Uint8Array, recipients: string, armor: boolean): Uint8Array;
  decrypt(ciphertext: Uint8Array, identity: Uint8Array): Uint8Array;
  sealWithPassphrase(plaintext: Uint8Array, passphrase: Uint8Array, logN: number): Uint8Array;
  openWithPassphrase(sealed: Uint8Array, passphrase: Uint8Array): Uint8Array;
  passphraseWorkFactor(): number;
  wrapContainer(name: string, contents: Uint8Array): Uint8Array;
  unwrapContainer(archive: Uint8Array): { name: string; contents: Uint8Array };
}

let loading: Promise<CryptoModule> | undefined;

/** The module, loaded once per page. A failure is not kept: the next call tries again. */
export function loadModule(): Promise<CryptoModule> {
  loading ??= (async () => {
    // A file of this origin, not part of the bundle: the bundler must leave both the address and the load to the browser. (The address is
    // in a variable so that TypeScript does not look for a module of that name.)
    const address: string = "/fjord-wasm/fjord_wasm.js";
    const loaded = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ address)) as unknown as CryptoModule & {
      default: (input: { module_or_path: string }) => Promise<unknown>;
    };
    await loaded.default({ module_or_path: "/fjord-wasm/fjord_wasm_bg.wasm" });
    return loaded;
  })().catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}
