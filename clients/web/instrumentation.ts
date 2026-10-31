/**
 * Next calls `register` once when the server starts, in every runtime it has (Node.js and Edge), so what only Node.js can do is in
 * `instrumentation-node.ts`, imported only there: the database client and `process.exit` must not be seen by the Edge build, which warned
 * of the latter at every request in development. Written as Next's guide writes it (`NEXT_RUNTIME === "nodejs"` around the import), which is
 * what the bundler can see through and drop for Edge.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}
