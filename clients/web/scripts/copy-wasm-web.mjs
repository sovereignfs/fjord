// Put the browser build of the format module where the app serves it: `public/fjord-wasm/` (ROADMAP 2a.2). The module is built by
// `crates/fjord-wasm/build.sh` (`pnpm build:wasm`), which writes `pkg/web/`; a page loads it from `/fjord-wasm/fjord_wasm.js` and its
// `.wasm` beside it. The copy is not committed (`.gitignore`), and the image makes the same copy from its wasm stage (Dockerfile).
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, "..", "..", "..", "crates", "fjord-wasm", "pkg", "web");
const to = join(here, "..", "public", "fjord-wasm");
if (!existsSync(join(from, "fjord_wasm.js"))) {
  console.error(`The browser build of the format module is not at ${from}: run crates/fjord-wasm/build.sh first.`);
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
for (const file of ["fjord_wasm.js", "fjord_wasm_bg.wasm"]) cpSync(join(from, file), join(to, file));
console.log(`copied the browser build of the format module to ${to}`);
