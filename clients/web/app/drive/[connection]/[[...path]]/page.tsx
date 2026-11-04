import { RepositoryRoute } from "../../../../src/browse/screens/RepositoryRoute";
import { repositoryMetadata } from "../../../../src/browse/screens/repository-title";

export const dynamic = "force-dynamic";
export const generateMetadata = repositoryMetadata;

/** A drive's page, and a place inside it: see `RepositoryRoute`. */
export default function Page(props: { params: Promise<{ connection: string; path?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <RepositoryRoute kind="drive" {...props} />;
}
