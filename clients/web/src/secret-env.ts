import { ConfigError, type Env } from "./db/config";

/** Reads a file named by a `*_FILE` variable; injected so a test needs no file. */
export type ReadFile = (path: string) => string;

/** A value from `NAME`, or from the file `NAME_FILE` names (its trailing newline trimmed). */
export function resolveSecret(name: string, env: Env, readFile: ReadFile): string | undefined {
  const direct = env[name];
  const file = (env[`${name}_FILE`] ?? "").trim();
  if (direct && file) throw new ConfigError(`Set ${name} or ${name}_FILE, not both.`);
  if (file) {
    try {
      return readFile(file).replace(/\r?\n$/, "");
    } catch {
      throw new ConfigError(`${name}_FILE names a file that cannot be read.`);
    }
  }
  return direct === undefined || direct === "" ? undefined : direct;
}
