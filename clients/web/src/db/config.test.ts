import { describe, expect, it } from 'vitest';
import { ConfigError, describeConfig, resolveDatabaseConfig } from './config';

const noFile = (): string => {
  throw new Error('no file');
};

describe('resolveDatabaseConfig', () => {
  it('defaults to SQLite through an sqld service', () => {
    expect(resolveDatabaseConfig({})).toEqual({
      dialect: 'sqlite',
      form: 'sqld',
      url: 'http://sqld:8080',
      adminUrl: 'http://sqld:8081',
    });
  });

  it('treats an empty FJORD_DB_DIALECT as unset, and ignores case and spaces', () => {
    expect(resolveDatabaseConfig({ FJORD_DB_DIALECT: '' })).toMatchObject({
      dialect: 'sqlite',
      form: 'sqld',
    });
    expect(resolveDatabaseConfig({ FJORD_DB_DIALECT: ' SQLD ' })).toMatchObject({
      dialect: 'sqlite',
      form: 'sqld',
    });
  });

  it('reads an sqld URL and its admin URL, without a trailing slash', () => {
    expect(
      resolveDatabaseConfig({
        FJORD_DB_DIALECT: 'sqld',
        FJORD_SQLD_URL: 'http://localhost:28080/',
        FJORD_SQLD_ADMIN_URL: 'http://localhost:28081/',
      }),
    ).toEqual({
      dialect: 'sqlite',
      form: 'sqld',
      url: 'http://localhost:28080',
      adminUrl: 'http://localhost:28081',
    });
  });

  it.each([
    ['file:/data/fjord.db', '/data/fjord.db', '/data/fjord_auth.db'],
    ['file:///data/fjord.db', '/data/fjord.db', '/data/fjord_auth.db'],
    ['file:./data/fjord.db', './data/fjord.db', './data/fjord_auth.db'],
    ['file:fjord.db', 'fjord.db', 'fjord_auth.db'],
  ])(
    'reads the file %s with FJORD_DB_DIALECT=sqlite, and puts the auth database beside it',
    (url, path, authPath) => {
      expect(resolveDatabaseConfig({ FJORD_DB_DIALECT: 'sqlite', FJORD_SQLITE_URL: url })).toEqual({
        dialect: 'sqlite',
        form: 'file',
        path,
        authPath,
      });
    },
  );

  it.each(['file:', 'file:///', 'file::memory:', 'file:/data/'])(
    'refuses the file URL %s',
    (url) => {
      expect(() =>
        resolveDatabaseConfig({ FJORD_DB_DIALECT: 'sqlite', FJORD_SQLITE_URL: url }),
      ).toThrow(ConfigError);
    },
  );

  it('requires a file for sqlite, and refuses an address there', () => {
    expect(() => resolveDatabaseConfig({ FJORD_DB_DIALECT: 'sqlite' })).toThrow(
      /requires FJORD_SQLITE_URL/,
    );
    expect(() =>
      resolveDatabaseConfig({ FJORD_DB_DIALECT: 'sqlite', FJORD_SQLITE_URL: 'http://sqld:8080' }),
    ).toThrow(/FJORD_DB_DIALECT=sqld/);
  });

  it('refuses an sqld URL that is not http(s), and says where a file goes', () => {
    expect(() => resolveDatabaseConfig({ FJORD_SQLD_URL: 'libsql://example.turso.io' })).toThrow(
      /FJORD_SQLD_URL/,
    );
    expect(() => resolveDatabaseConfig({ FJORD_SQLD_URL: 'file:/data/fjord.db' })).toThrow(
      /FJORD_SQLITE_URL/,
    );
    expect(() => resolveDatabaseConfig({ FJORD_SQLD_URL: 'not a url' })).toThrow(
      /FJORD_SQLD_URL is not a valid URL/,
    );
  });

  it('refuses an admin URL that is not http(s)', () => {
    expect(() => resolveDatabaseConfig({ FJORD_SQLD_ADMIN_URL: 'ftp://sqld:8081' })).toThrow(
      /FJORD_SQLD_ADMIN_URL/,
    );
  });

  it('reads PostgreSQL, with a default pool size', () => {
    expect(
      resolveDatabaseConfig({
        FJORD_DB_DIALECT: 'postgres',
        FJORD_POSTGRES_URL: 'postgres://u:p@db:5432/fjord',
      }),
    ).toEqual({
      dialect: 'postgres',
      url: 'postgres://u:p@db:5432/fjord',
      poolMax: 5,
    });
  });

  it('reads the PostgreSQL address from a file, as an instance gives a secret', () => {
    const config = resolveDatabaseConfig(
      { FJORD_DB_DIALECT: 'postgres', FJORD_POSTGRES_URL_FILE: '/run/secrets/db' },
      (path) => (path === '/run/secrets/db' ? 'postgres://u:p@db:5432/fjord\n' : noFile()),
    );
    expect(config).toMatchObject({ dialect: 'postgres', url: 'postgres://u:p@db:5432/fjord' });
  });

  it('refuses the PostgreSQL address both directly and from a file', () => {
    expect(() =>
      resolveDatabaseConfig(
        {
          FJORD_DB_DIALECT: 'postgres',
          FJORD_POSTGRES_URL: 'postgres://u:p@db/fjord',
          FJORD_POSTGRES_URL_FILE: '/x',
        },
        noFile,
      ),
    ).toThrow(/not both/);
  });

  it('requires FJORD_POSTGRES_URL for PostgreSQL, and it must be a postgres URL, without repeating it', () => {
    expect(() => resolveDatabaseConfig({ FJORD_DB_DIALECT: 'postgres' })).toThrow(
      /FJORD_POSTGRES_URL/,
    );
    expect(() =>
      resolveDatabaseConfig({ FJORD_DB_DIALECT: 'postgres', FJORD_POSTGRES_URL: 'http://db' }),
    ).toThrow(/postgres:\/\//);
    const bad = () =>
      resolveDatabaseConfig({
        FJORD_DB_DIALECT: 'postgres',
        FJORD_POSTGRES_URL: 'hunter2 is not a url',
      });
    expect(bad).toThrow(/FJORD_POSTGRES_URL is not a valid URL/);
    expect(bad).not.toThrow(/hunter2/);
  });

  it('does not infer the dialect from a URL', () => {
    // A PostgreSQL URL with the default dialect is a mistake to report, not a hint.
    const config = resolveDatabaseConfig({ FJORD_POSTGRES_URL: 'postgres://u:p@db/fjord' });
    expect(config).toMatchObject({ dialect: 'sqlite', form: 'sqld' });
  });

  it('refuses an unknown dialect', () => {
    expect(() => resolveDatabaseConfig({ FJORD_DB_DIALECT: 'mysql' })).toThrow(
      /FJORD_DB_DIALECT must be "sqld", "sqlite" or "postgres"/,
    );
  });

  it('takes the pool size and CA file for PostgreSQL, and ignores a bad pool size', () => {
    const base = { FJORD_DB_DIALECT: 'postgres', FJORD_POSTGRES_URL: 'postgres://u:p@db/fjord' };
    expect(
      resolveDatabaseConfig({ ...base, FJORD_POSTGRES_POOL_MAX: '12', PGSSLROOTCERT: '/ca.pem' }),
    ).toMatchObject({
      poolMax: 12,
      sslRootCertPath: '/ca.pem',
    });
    for (const bad of ['0', '-3', 'many', '2.5', '']) {
      expect(resolveDatabaseConfig({ ...base, FJORD_POSTGRES_POOL_MAX: bad })).toMatchObject({
        poolMax: 5,
      });
    }
  });
});

describe('resolveDatabaseConfig with the old names', () => {
  it('reads an sqld service from SQLITE_URL and SQLD_ADMIN_URL', () => {
    expect(
      resolveDatabaseConfig({
        DB_DIALECT: 'sqlite',
        SQLITE_URL: 'http://localhost:28080/',
        SQLD_ADMIN_URL: 'http://localhost:28081',
      }),
    ).toEqual({
      dialect: 'sqlite',
      form: 'sqld',
      url: 'http://localhost:28080',
      adminUrl: 'http://localhost:28081',
    });
  });

  it('reads a file from SQLITE_URL, with or without DB_DIALECT', () => {
    const file = {
      dialect: 'sqlite',
      form: 'file',
      path: '/data/fjord.db',
      authPath: '/data/fjord_auth.db',
    };
    expect(resolveDatabaseConfig({ SQLITE_URL: 'file:/data/fjord.db' })).toEqual(file);
    expect(
      resolveDatabaseConfig({ DB_DIALECT: ' SQLite ', SQLITE_URL: 'file:/data/fjord.db' }),
    ).toEqual(file);
  });

  it('reads PostgreSQL from POSTGRES_DB_URL and POSTGRES_POOL_MAX', () => {
    expect(
      resolveDatabaseConfig({
        DB_DIALECT: 'postgres',
        POSTGRES_DB_URL: 'postgres://u:p@db/fjord',
        POSTGRES_POOL_MAX: '7',
      }),
    ).toEqual({
      dialect: 'postgres',
      url: 'postgres://u:p@db/fjord',
      poolMax: 7,
    });
    expect(() => resolveDatabaseConfig({ DB_DIALECT: 'postgres' })).toThrow(/FJORD_POSTGRES_URL/);
  });

  it('refuses an old dialect that never existed, and names the new variable', () => {
    expect(() => resolveDatabaseConfig({ DB_DIALECT: 'mysql' })).toThrow(
      /DB_DIALECT must be "sqlite" or "postgres".*FJORD_DB_DIALECT/,
    );
    // `sqld` is a new value, not an old one: under the old name it was never accepted.
    expect(() => resolveDatabaseConfig({ DB_DIALECT: 'sqld' })).toThrow(ConfigError);
  });

  it('refuses old and new names together', () => {
    expect(() =>
      resolveDatabaseConfig({
        DB_DIALECT: 'postgres',
        FJORD_POSTGRES_URL: 'postgres://u:p@db/fjord',
      }),
    ).toThrow(/FJORD_POSTGRES_URL and DB_DIALECT/);
    expect(() =>
      resolveDatabaseConfig({ SQLITE_URL: 'file:/a.db', FJORD_DB_DIALECT: 'sqlite' }),
    ).toThrow(/not both/);
  });

  it('ignores an old name that is set but empty', () => {
    expect(
      resolveDatabaseConfig({
        DB_DIALECT: '',
        FJORD_DB_DIALECT: 'sqlite',
        FJORD_SQLITE_URL: 'file:/a.db',
      }),
    ).toMatchObject({ form: 'file' });
  });
});

describe('describeConfig', () => {
  it('never prints a password', () => {
    const text = describeConfig(
      resolveDatabaseConfig({
        FJORD_DB_DIALECT: 'postgres',
        FJORD_POSTGRES_URL: 'postgres://fjord:hunter2@db:5432/app',
      }),
    );
    expect(text).toBe('postgres db:5432/app');
    expect(text).not.toContain('hunter2');
  });

  it('describes the SQLite forms', () => {
    expect(describeConfig(resolveDatabaseConfig({}))).toBe('sqlite via sqld at http://sqld:8080');
    expect(
      describeConfig(
        resolveDatabaseConfig({ FJORD_DB_DIALECT: 'sqlite', FJORD_SQLITE_URL: 'file:/d/f.db' }),
      ),
    ).toBe('sqlite file /d/f.db');
  });
});
