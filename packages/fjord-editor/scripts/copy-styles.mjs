// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The package's one stylesheet goes next to the code it styles, because `tsc` emits code and not CSS.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";

mkdirSync("dist", { recursive: true });
copyFileSync("src/styles.css", "dist/styles.css");

// So that `import "fjord-editor/styles.css"` type-checks in a project that does not already allow stylesheet imports.
writeFileSync("dist/styles.d.ts", "// A stylesheet, imported for its effect.\nexport {};\n");
