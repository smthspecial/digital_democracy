import { proxy } from "../../lib/proxy";
type Context = { params: Promise<{ path: string[] }> };
async function handle(request: Request, context: Context): Promise<Response> {
  return proxy(request, (await context.params).path);
}
export { handle as GET, handle as POST };
