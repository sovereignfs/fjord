/**
 * What a person chooses about how Fjord looks (Account, Preferences): kept **in this browser** and applied at once, as the legacy Sovereign's page says "to every session on this
 * device". It is not the account's, so it is not sent anywhere; without storage a choice lasts until the page is left. `script.ts` applies what is kept before first paint.
 */
export const THEME_KEY = "fjord.theme";
export const TEXT_SIZE_KEY = "fjord.textSize";

export type ThemeChoice = "system" | "light" | "dark";
export type TextSize = "default" | "large" | "larger";

export const themeOf = (value: string | null): ThemeChoice => (value === "light" || value === "dark" ? value : "system");
export const textSizeOf = (value: string | null): TextSize => (value === "large" || value === "larger" ? value : "default");

function read(storage: Pick<Storage, "getItem"> | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage: Pick<Storage, "setItem" | "removeItem"> | undefined, key: string, value: string | null) {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, value);
  } catch {
    // Not kept: it still applies to this page.
  }
}

export const readTheme = (storage?: Pick<Storage, "getItem">): ThemeChoice => themeOf(read(storage, THEME_KEY));
export const readTextSize = (storage?: Pick<Storage, "getItem">): TextSize => textSizeOf(read(storage, TEXT_SIZE_KEY));

/** Choose the theme: kept (`system` is the absence of a choice) and put on the page, following the system's scheme for `system`. */
export function chooseTheme(choice: ThemeChoice, root: { setAttribute(name: string, value: string): void }, systemIsDark: boolean, storage?: Pick<Storage, "setItem" | "removeItem">) {
  write(storage, THEME_KEY, choice === "system" ? null : choice);
  root.setAttribute("data-theme", choice === "system" ? (systemIsDark ? "dark" : "light") : choice);
}

/** Choose the text size: kept (`default` is the absence of a choice) and put on the page, where the root's font size follows it. */
export function chooseTextSize(size: TextSize, root: { setAttribute(name: string, value: string): void; removeAttribute(name: string): void }, storage?: Pick<Storage, "setItem" | "removeItem">) {
  write(storage, TEXT_SIZE_KEY, size === "default" ? null : size);
  if (size === "default") root.removeAttribute("data-text-size");
  else root.setAttribute("data-text-size", size);
}
