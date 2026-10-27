/**
 * Node 24.7 added `crypto.argon2` (and `argon2Sync`), which the app uses for the passwords on share links (`sharing/password.ts`) instead of
 * a dependency. The project's `@types/node` is the 22 line, which does not know them, so they are declared here, as Node documents them.
 * Delete this file when `@types/node` is 24 or later and has them.
 */
declare module "node:crypto" {
  interface Argon2Parameters {
    message: string | NodeJS.ArrayBufferView;
    nonce: string | NodeJS.ArrayBufferView;
    parallelism: number;
    tagLength: number;
    memory: number;
    passes: number;
    secret?: string | NodeJS.ArrayBufferView;
    associatedData?: string | NodeJS.ArrayBufferView;
  }
  type Argon2Algorithm = "argon2d" | "argon2i" | "argon2id";
  function argon2(algorithm: Argon2Algorithm, parameters: Argon2Parameters, callback: (error: Error | null, key: Buffer) => void): void;
  function argon2Sync(algorithm: Argon2Algorithm, parameters: Argon2Parameters): Buffer;
}
