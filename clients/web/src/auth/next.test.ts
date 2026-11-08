import { describe, expect, it } from 'vitest';
import { safeNext, signInAddress } from './next';

describe('where signing in goes on to', () => {
  it('is a page of this site, with its query', () => {
    expect(safeNext('/d/01jagc4k7pt8y3wqnmzv5xrb8j')).toBe('/d/01jagc4k7pt8y3wqnmzv5xrb8j');
    expect(safeNext('/drive/k3x9m2qa/v/abc')).toBe('/drive/k3x9m2qa/v/abc');
    expect(safeNext('/account?section=security&tab=keys')).toBe(
      '/account?section=security&tab=keys',
    );
  });

  it('is never another site, however it is written', () => {
    for (const value of [
      'https://evil.example/',
      '//evil.example',
      '/\\evil.example',
      '\\\\evil.example',
      'http:evil.example',
      'javascript:alert(1)',
      'evil.example',
      ' /d/x',
      '/\t/evil.example',
      '/d/x\r\nset-cookie: a=b',
    ]) {
      expect(safeNext(value), value).toBeNull();
    }
  });

  it('never carries a token, and is nothing for a page signing in lands near anyway', () => {
    expect(safeNext('/d/abc?token=secret')).toBeNull();
    for (const value of [
      '/',
      '/home',
      '/open',
      '/sign-in',
      '/sign-in/two-factor',
      '/sign-up',
      '/api/health',
      '/forgot-password',
      '/reset-password',
    ])
      expect(safeNext(value), value).toBeNull();
    for (const value of [null, undefined, '', '/'.padEnd(3000, 'a')])
      expect(safeNext(value)).toBeNull();
  });
});

describe('the address of the sign-in page', () => {
  it('says where the person was going, as one query value', () => {
    expect(signInAddress('/d/abc')).toBe('/sign-in?next=%2Fd%2Fabc');
    expect(signInAddress('/account?section=security&tab=keys')).toBe(
      '/sign-in?next=%2Faccount%3Fsection%3Dsecurity%26tab%3Dkeys',
    );
  });

  it('is plain when there is nowhere to go on to', () => {
    expect(signInAddress(null)).toBe('/sign-in');
    expect(signInAddress('//evil.example')).toBe('/sign-in');
    expect(signInAddress('/')).toBe('/sign-in');
  });
});
