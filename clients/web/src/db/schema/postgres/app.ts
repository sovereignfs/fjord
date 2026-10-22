import { index, pgSchema, text } from "drizzle-orm/pg-core";
import { APP_STORE } from "../../config";
import { epochMs, id64 } from "./columns";

/** The app's schema; better-auth's is `fjord_auth` (DESIGN.md §14). */
export const app = pgSchema(APP_STORE);

/** Notices from the worker to the web processes; see `schema/sqlite/app.ts`. */
export const event = app.table(
  "event",
  {
    id: id64("id"),
    kind: text("kind").notNull(),
    subject: text("subject").notNull(),
    createdAt: epochMs("created_at").notNull(),
  },
  (table) => [index("event_created_at_idx").on(table.createdAt)],
);
