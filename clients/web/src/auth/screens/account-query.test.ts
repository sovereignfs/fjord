import { describe, expect, it } from 'vitest';
import { sectionOf } from './account-query';

describe('which section of the account an address opens', () => {
  it('is the one it names, and Profile when it names none', () => {
    expect(sectionOf({})).toBe('profile');
    for (const section of ['profile', 'security', 'preferences'] as const)
      expect(sectionOf({ section })).toBe(section);
    expect(sectionOf({ section: 'billing' })).toBe('profile');
  });

  it('is Security for the way back from linking Sovereign and for the older addresses of the key and of security', () => {
    for (const query of [
      { error: 'x' },
      { linked: '1' },
      { unlinked: '1' },
      { tab: 'keys' },
      { tab: 'security' },
    ])
      expect(sectionOf(query), JSON.stringify(query)).toBe('security');
  });

  it('lets a section that is named win over what else the address carries', () => {
    expect(sectionOf({ section: 'preferences', linked: '1' })).toBe('preferences');
    expect(sectionOf({ section: 'profile', tab: 'keys' })).toBe('profile');
  });
});
