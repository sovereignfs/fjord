import { authConfig, getSession } from '../../../../../src/auth/server';
import { handleGuestDraft } from '../../../../../src/sharing/guest-http';
import { saveMemberDraftFor } from '../../../../../src/sharing/server';

export const dynamic = 'force-dynamic';

/**
 * An edit of a document shared with the signed-in account at the edit role: into the document's working copy, for the owner to review (`src/sharing/member.ts`). It answers as the link's
 * route does (`PUT /d/<id>/draft`), with the account's session in place of a cookie; the name is the account's, whatever is sent.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const config = authConfig();
  if (!config.enabled) return new Response(null, { status: 404 });
  const session = await getSession();
  if (!session)
    return new Response(
      JSON.stringify({ error: { code: 'unauthorized', message: 'Sign in first.' } }),
      { status: 401, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
    );
  return handleGuestDraft(
    request,
    {
      origin: config.url,
      save: ({ docId, body }) => saveMemberDraftFor(session.user.id, docId, body),
      subject: 'share',
    },
    (await params).id,
  );
}
