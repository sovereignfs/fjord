import {
  ConfigError as SettingsError,
  defineConfig,
  Secret,
  secret,
  string,
  type Variable,
} from '@sovereignfs/config';
import { ConfigError, type Env } from './db/config';

/** Reads a file named by a `*_FILE` variable; injected so a test needs no file. */
export type ReadFile = (path: string) => string;

const PREFIX = 'FJORD_';

/** The settings a reader declares, by their full names: those read as text, and the secrets. */
export interface Declared<T extends string, S extends string> {
  text: readonly T[];
  secrets: readonly S[];
}

/**
 * Reads the declared settings through `@sovereignfs/config`, the suite's environment convention
 * (`contracts/env.md` in sovereignfs/sovereign), and gives them back by their full names. A blank
 * value is no value, and text is trimmed. A secret may be `NAME` or the file `NAME_FILE` names (one
 * trailing newline dropped), never both; only a secret takes the file form, so a `_FILE` given for
 * any other setting is refused rather than ignored. Every problem is reported at once, naming its
 * variable and never a value or a path.
 *
 * Old names are not read here: a reader maps them onto the new ones first (`src/env-renames.ts`).
 */
export function readSettings<T extends string, S extends string>(
  env: Env,
  declared: Declared<T, S>,
  readFile: ReadFile,
): Partial<Record<T | S, string>> {
  const short = (name: string) => name.slice(PREFIX.length);
  const config = defineConfig({
    prefix: 'FJORD',
    variables: Object.fromEntries([
      ...declared.text.map((name) => [name, string({ name: short(name) })] as const),
      ...declared.secrets.map((name) => [name, secret({ name: short(name) })] as const),
    ]) as Record<string, Variable<string | Secret | undefined>>,
  });

  const notFiles = declared.text
    .map((name) => `${name}_FILE`)
    .filter((name) => (env[name] ?? '').trim() !== '')
    .map((name) => `${name} is not read: only a secret can be given as a file.`);

  let values: Record<string, string | Secret | undefined> = {};
  let problems: string[] = [];
  try {
    values = config.load({ ...env }, { readFile });
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    problems = error.problems.map((problem) => `${problem.variable} ${problem.message}.`);
  }
  if (notFiles.length > 0 || problems.length > 0)
    throw new ConfigError([...notFiles, ...problems].join(' '));

  const out: Partial<Record<string, string>> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) out[name] = value instanceof Secret ? value.reveal() : value;
  }
  return out as Partial<Record<T | S, string>>;
}
