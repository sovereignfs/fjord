import { describe, expect, it } from 'vitest';
import {
  TEXT_SIZE_KEY,
  THEME_KEY,
  chooseTextSize,
  chooseTheme,
  readTextSize,
  readTheme,
  textSizeOf,
  themeOf,
} from './preferences';
import { themeScript } from './script';

const memory = (initial: Record<string, string> = {}) => {
  const data = { ...initial };
  return {
    data,
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => void (data[key] = value),
    removeItem: (key: string) => void delete data[key],
  };
};
const root = () => {
  const attributes: Record<string, string> = {};
  return {
    attributes,
    setAttribute: (name: string, value: string) => void (attributes[name] = value),
    removeAttribute: (name: string) => void delete attributes[name],
  };
};

describe('what a person chooses about how Fjord looks', () => {
  it('reads only what it knows, and anything else is the default', () => {
    expect(themeOf('dark')).toBe('dark');
    expect(themeOf('light')).toBe('light');
    for (const value of [null, '', 'system', 'blue']) expect(themeOf(value)).toBe('system');
    expect(textSizeOf('large')).toBe('large');
    expect(textSizeOf('larger')).toBe('larger');
    for (const value of [null, '', 'default', 'huge']) expect(textSizeOf(value)).toBe('default');
    expect(readTheme(undefined)).toBe('system');
    expect(
      readTheme({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toBe('system');
  });

  it("keeps a theme and puts it on the page, and the system's choice is the absence of one", () => {
    const store = memory();
    const page = root();
    chooseTheme('dark', page, false, store);
    expect(store.data[THEME_KEY]).toBe('dark');
    expect(page.attributes['data-theme']).toBe('dark');
    expect(readTheme(store)).toBe('dark');
    chooseTheme('system', page, true, store);
    expect(store.data[THEME_KEY]).toBeUndefined();
    expect(page.attributes['data-theme']).toBe('dark');
    chooseTheme('system', page, false, store);
    expect(page.attributes['data-theme']).toBe('light');
  });

  it('keeps a text size and puts it on the page, and the default is the absence of one', () => {
    const store = memory();
    const page = root();
    chooseTextSize('larger', page, store);
    expect(store.data[TEXT_SIZE_KEY]).toBe('larger');
    expect(page.attributes['data-text-size']).toBe('larger');
    expect(readTextSize(store)).toBe('larger');
    chooseTextSize('default', page, store);
    expect(store.data[TEXT_SIZE_KEY]).toBeUndefined();
    expect(page.attributes['data-text-size']).toBeUndefined();
  });

  it('still applies for this page when nothing can be kept', () => {
    const page = root();
    const blocked = {
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    chooseTheme('light', page, true, blocked);
    chooseTextSize('large', page, blocked);
    expect(page.attributes).toEqual({ 'data-theme': 'light', 'data-text-size': 'large' });
  });

  it('is what the script before the first paint reads, under the same keys', () => {
    for (const [chosen, system, size] of [
      ['dark', false, 'large'],
      ['light', true, 'larger'],
      [null, true, null],
      [null, false, null],
    ] as const) {
      const attributes: Record<string, string> = {};
      const data: Record<string, string> = {};
      if (chosen) data[THEME_KEY] = chosen;
      if (size) data[TEXT_SIZE_KEY] = size;
      const window = {
        localStorage: memory(data),
        matchMedia: () => ({ matches: system, addEventListener: () => undefined }),
      };
      new Function('window', 'document', themeScript)(window, {
        documentElement: { setAttribute: (n: string, v: string) => void (attributes[n] = v) },
      });
      expect(attributes['data-theme']).toBe(chosen ?? (system ? 'dark' : 'light'));
      expect(attributes['data-text-size']).toBe(size ?? undefined);
    }
  });
});
