/**
 * What a repository is called where a person reads it: `owner/name` for one in a git host, and just its name for one that is kept on this
 * server (`local/notes` would suggest a place it is not). A pure function, so the browser can import it.
 */
export const connectionLabel = (connection: { provider: "github" | "local"; owner: string; name: string }): string => (connection.provider === "local" ? connection.name : `${connection.owner}/${connection.name}`);
