import { accountContext } from '../../../../src/account/context';
import { handleChangeEmail } from '../../../../src/account/http';

// Who is asking is decided per request, from their cookies.
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const context = await accountContext();
  return context
    ? handleChangeEmail(request, context.caller, context.deps)
    : new Response(null, { status: 404 });
}
