"use client";

/**
 * The design system, for pages to import. `@sovereignfs/ui` is one bundle with no
 * `"use client"` directive and it calls `createContext` at module scope, so a Server
 * Component that imports it directly fails to build ("createContext is not a function").
 * Re-exporting from a client module makes each component a client reference: it still
 * renders on the server, into the static HTML, and no page needs to be a client component.
 *
 * Export only what is used; a Server Component cannot pass functions to these, only
 * data and children.
 */
export { Alert, Badge, Button, Card, FormField, Icon, Input } from "@sovereignfs/ui";
