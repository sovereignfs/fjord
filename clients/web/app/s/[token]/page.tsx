import { AuthShell } from "../../../src/auth/screens/AuthShell";
import { SealedView } from "../../../src/sealed/SealedView";

export const dynamic = "force-dynamic";
// A shared copy is for whoever has the link: not for a search engine to keep.
export const metadata = { title: "Shared document", robots: { index: false, follow: false } };

/**
 * A sealed copy of an encrypted document, opened by its link (ROADMAP 2c.1). The token in the path finds the copy; the key that opens it is in the address's fragment, which
 * never reaches the server. Anyone may ask: it is the key, not a session, that opens it.
 */
export default async function SealedSharePage({ params }: { params: Promise<{ token: string }> }) {
  return (
    <AuthShell title="Shared document" wide>
      <SealedView token={(await params).token} />
    </AuthShell>
  );
}
