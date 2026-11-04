import { RepositoryRoute } from "../../../../src/browse/screens/RepositoryRoute";

export const dynamic = "force-dynamic";
export const metadata = { title: "Repository" };

/** A ssg's page, and a place inside it: see `RepositoryRoute`. */
export default function Page(props: { params: Promise<{ connection: string; path?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <RepositoryRoute kind="ssg" {...props} />;
}
