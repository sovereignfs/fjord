export type AccountSection = 'profile' | 'security' | 'preferences';

/**
 * What the address says: which section of the account to open (`section`), which part of Security (`tab=keys` for the encryption identity; the rest is General), and about the
 * way back from linking Sovereign (or the reason it failed). The first forms of this address said `tab=security` and `tab=keys` for what are now a section and a part, and still arrive.
 */
export interface AccountQuery {
  section?: string | undefined;
  tab?: string | undefined;
  error?: string | undefined;
  linked?: string | undefined;
  unlinked?: string | undefined;
}

/** The section the address asks for: Security for the way back from linking Sovereign and for the older addresses of the key, Profile when it says nothing. */
export function sectionOf(query: AccountQuery): AccountSection {
  if (
    query.section === 'profile' ||
    query.section === 'security' ||
    query.section === 'preferences'
  )
    return query.section;
  const security =
    query.tab === 'security' ||
    query.tab === 'keys' ||
    query.error !== undefined ||
    query.linked !== undefined ||
    query.unlinked !== undefined;
  return security ? 'security' : 'profile';
}
