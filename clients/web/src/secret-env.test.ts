import { describe, expect, it } from 'vitest';
import { ConfigError } from './db/config';
import { readSettings } from './secret-env';

const declared = { text: ['FJORD_URL'], secrets: ['FJORD_AUTH_SECRET'] } as const;
const noFile = () => {
  throw new Error('ENOENT /secret/path');
};

describe('readSettings', () => {
  it('trims text, treats blank as unset, and takes a secret exactly as given', () => {
    expect(
      readSettings({ FJORD_URL: ' https://x.test ', FJORD_AUTH_SECRET: ' s ' }, declared, noFile),
    ).toEqual({ FJORD_URL: 'https://x.test', FJORD_AUTH_SECRET: ' s ' });
    expect(readSettings({ FJORD_URL: '  ', FJORD_AUTH_SECRET: '' }, declared, noFile)).toEqual({});
  });

  it('reads a secret from its file, dropping one trailing newline', () => {
    expect(readSettings({ FJORD_AUTH_SECRET_FILE: '/run/s' }, declared, () => 'value\n\n')).toEqual(
      { FJORD_AUTH_SECRET: 'value\n' },
    );
  });

  it('refuses a secret given both ways', () => {
    expect(() =>
      readSettings({ FJORD_AUTH_SECRET: 'a', FJORD_AUTH_SECRET_FILE: '/f' }, declared, () => 'b'),
    ).toThrow('FJORD_AUTH_SECRET is set together with FJORD_AUTH_SECRET_FILE; set only one.');
  });

  it('refuses a file for a setting that is not a secret, rather than ignoring it', () => {
    expect(() => readSettings({ FJORD_URL_FILE: '/f' }, declared, noFile)).toThrow(
      'FJORD_URL_FILE is not read: only a secret can be given as a file.',
    );
  });

  it('names an unreadable file and never its path or the cause, and reports every problem at once', () => {
    let error: unknown;
    try {
      readSettings(
        { FJORD_AUTH_SECRET_FILE: '/secret/path', FJORD_URL_FILE: '/u' },
        declared,
        noFile,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).toContain('FJORD_AUTH_SECRET_FILE names a file that cannot be read.');
    expect(message).toContain('FJORD_URL_FILE is not read');
    expect(message).not.toContain('/secret/path');
    expect(message).not.toContain('ENOENT');
  });
});
