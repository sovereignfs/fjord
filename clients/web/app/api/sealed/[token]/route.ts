import { sealedOpenContext } from "../../../../src/sealed/context";
import { handleSealedOpen } from "../../../../src/sealed/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  return handleSealedOpen(request, sealedOpenContext().deps, (await params).token);
}
