// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** @type {import('@ladle/react').UserConfig} */
export default {
  stories: "stories/**/*.stories.{tsx,ts}",
  // The package is MPL-2.0 and imports nothing of any client; the stories show it with its own default look.
  addons: { a11y: { enabled: false }, rtl: { enabled: false } },
};
