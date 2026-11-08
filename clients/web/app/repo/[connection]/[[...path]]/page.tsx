import { repositoryRedirect } from '../../../../src/browse/screens/RepositoryRoute';

export const dynamic = 'force-dynamic';

/** What every repository address was, before they began with the kind (`/repo/<repo>/…`): sent to the repository's own (`/drive/…`, `/journal/…`, `/ssg/…`). */
export default function Page(props: {
  params: Promise<{ connection: string; path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<never> {
  return repositoryRedirect(props);
}
