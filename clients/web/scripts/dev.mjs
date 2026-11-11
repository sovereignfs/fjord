// `pnpm dev`: Next's dev server on port 3001, with defaults that let a fresh checkout run with no Docker and no settings.
//
// The app's own defaults are an operator's (README, "The database"): with no database named it looks for an sqld service at
// `http://sqld:8080`, which exists only inside the Compose setup, and sign-in is off, so every page that needs an account is a 404.
// Run bare, `next dev` therefore stops at start-up with "could not reach the sqld admin API". This fills in only what is not set,
// for development, and says what it chose:
//
//   - the database: a SQLite file, `data/fjord.db` (`data/` is not committed);
//   - sign-in: email and password, open sign-up, at http://localhost:3001, with a signing secret made once and kept in
//     `data/dev-auth-secret`. Settings for Sovereign sign-in, or for a different database, are left as they are;
//   - the instance key that seals a repository's token (`FJORD_ENCRYPTION_KEY`), made once and kept in `data/dev-encryption-key`, so
//     that a repository can be connected.
//
// A setting you make (in the environment, or in `.env.local`, `.env.development.local`, `.env.development` or `.env`) always wins, and
// nothing is changed in a deployed build: this is run by `pnpm dev` and nothing else.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// The manifest is the one place the port is written (src/sovereign-manifest.test.ts holds this script to that).
const port = String(JSON.parse(readFileSync(join(root, 'sovereign.manifest.json'), 'utf8')).port);

/** The settings the files Next reads in development name, by their names. */
const filesText = ['.env.local', '.env.development.local', '.env.development', '.env']
  .map((name) => join(root, name))
  .filter(existsSync)
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');

/** Is a setting made, in the environment or in an env file? An empty value is not a setting. */
const isSet = (name) =>
  Boolean((process.env[name] ?? '').trim()) ||
  new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*\\S`, 'm').test(filesText);

const chosen = {};
const choose = (name, value, why) => {
  chosen[name] = value;
  notes.push(`  ${name}${why ? `  (${why})` : ''}`);
};
const notes = [];

// The database: any setting that names one is the developer's own.
const database = [
  'FJORD_DB_DIALECT',
  'DB_DIALECT',
  'FJORD_SQLITE_URL',
  'SQLITE_URL',
  'FJORD_SQLD_URL',
  'FJORD_POSTGRES_URL',
  'FJORD_POSTGRES_URL_FILE',
  'POSTGRES_DB_URL',
];
if (!database.some(isSet)) {
  mkdirSync(join(root, 'data'), { recursive: true });
  choose('FJORD_DB_DIALECT', 'sqlite', 'a file, no Docker: pnpm db:dev for sqld or PostgreSQL');
  choose('FJORD_SQLITE_URL', `file:${join(root, 'data', 'fjord.db')}`);
}

// Sign-in: off unless something turns it on, so only when nothing about it is set.
const signIn = [
  'FJORD_AUTH_LOCAL',
  'FJORD_CORE_URL',
  'FJORD_AUTH_SOVEREIGN_ISSUER',
  'FJORD_URL',
  'FJORD_AUTH_SECRET',
  'FJORD_AUTH_SECRET_FILE',
];
if (!signIn.some(isSet)) {
  mkdirSync(join(root, 'data'), { recursive: true });
  const secretFile = join(root, 'data', 'dev-auth-secret');
  if (!existsSync(secretFile))
    writeFileSync(secretFile, randomBytes(32).toString('base64'), { mode: 0o600 });
  choose('FJORD_AUTH_LOCAL', '1', 'email and password sign-in');
  choose('FJORD_URL', `http://localhost:${port}`);
  choose(
    'FJORD_AUTH_SECRET',
    readFileSync(secretFile, 'utf8').trim(),
    'kept in data/dev-auth-secret',
  );
  if (!isSet('FJORD_AUTH_SIGNUP'))
    choose('FJORD_AUTH_SIGNUP', 'open', 'anyone may create an account here');
}

// The key that credentials are sealed under: without one a repository's token cannot be kept. 32 bytes, base64 (src/crypto/config.ts).
if (!['FJORD_ENCRYPTION_KEY', 'FJORD_ENCRYPTION_KEY_FILE'].some(isSet)) {
  mkdirSync(join(root, 'data'), { recursive: true });
  const keyFile = join(root, 'data', 'dev-encryption-key');
  if (!existsSync(keyFile))
    writeFileSync(keyFile, randomBytes(32).toString('base64'), { mode: 0o600 });
  choose(
    'FJORD_ENCRYPTION_KEY',
    readFileSync(keyFile, 'utf8').trim(),
    'kept in data/dev-encryption-key',
  );
}

if (notes.length > 0) {
  // Names only, never a value.
  console.log(`[dev] settings not made, so for development:\n${notes.join('\n')}`);
  console.log('[dev] set any of them in clients/web/.env.local to use your own.\n');
}

// What the app imports and cannot start without: the editor package, built.
const editor = join(root, '..', '..', 'packages', 'fjord-editor', 'dist', 'index.js');
if (!existsSync(editor)) {
  console.log('[dev] packages/fjord-editor is not built: running `pnpm build:editor` (once)...');
  const built = spawnSync('pnpm', ['build:editor'], { cwd: root, stdio: 'inherit' });
  if (built.status !== 0) {
    console.error('[dev] `pnpm build:editor` failed, so the app cannot start.');
    process.exit(built.status ?? 1);
  }
}

// The format module needs Rust and wasm-bindgen, so it is not built here. The app starts without it, and says what to run where it is needed.
if (
  !existsSync(join(root, 'public', 'fjord-wasm', 'fjord_wasm_bg.wasm')) &&
  !isSet('FJORD_WASM_DIR')
)
  console.log(
    '[dev] the format module is not built: sign-in works, but opening a repository does not. Run `pnpm build:wasm` (needs Rust; crates/fjord-wasm/README.md).\n',
  );

const server = spawn('pnpm', ['exec', 'next', 'dev', '--port', port, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ...chosen },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
