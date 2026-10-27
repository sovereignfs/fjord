// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What the editors' look is made of. The stylesheet (`fjord-editor/styles.css`) uses these custom properties, each with
 * a default, and nothing else: a client sets them to its own palette and type (the Fjord Web app maps its design
 * system's tokens onto them), so the package needs no client's design system, and none of its licence.
 */
export const themeTokens = [
  "--fe-color-text",
  "--fe-color-muted",
  "--fe-color-surface",
  "--fe-color-border",
  "--fe-color-accent",
  "--fe-color-accent-text",
  "--fe-color-focus",
  "--fe-color-selection",
  "--fe-mark-bg",
  "--fe-mark-resolved-bg",
  "--fe-mark-active-bg",
  "--fe-font-body",
  "--fe-font-mono",
  "--fe-radius",
  "--fe-space",
] as const;

export type ThemeToken = (typeof themeTokens)[number];
