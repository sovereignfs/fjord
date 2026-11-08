import { describe, expect, it } from 'vitest';
import { dayText, localMomentText, momentText } from './dates';

describe('when, as the app says it', () => {
  const at = Date.UTC(2026, 10, 4, 22, 56);

  it('names the month, so it cannot be read two ways', () => {
    expect(dayText(at)).toBe('4 Nov 2026');
    expect(momentText(at)).toBe('4 Nov 2026, 22:56 UTC');
    expect(momentText(new Date(at).toISOString())).toBe('4 Nov 2026, 22:56 UTC');
  });

  it("is the reader's own time only where only a browser draws it, in the same form", () => {
    expect(localMomentText(at)).toMatch(/^\d{1,2} [A-Z][a-z]+ 2026, \d\d:\d\d$/);
  });
});
