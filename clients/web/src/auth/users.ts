import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { dbGet } from "../db/exec";
import * as postgresAuth from "../db/schema/postgres/auth";
import * as sqliteAuth from "../db/schema/sqlite/auth";

/** How many accounts there are. Sign-up policy and the sign-up page both ask. */
export async function countUsers(database: Database): Promise<number> {
  const table = database.dialect === "postgres" ? postgresAuth.user : sqliteAuth.user;
  const row = await dbGet<{ n: number | string }>(database, sql`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(row?.n ?? 0);
}

/** What a commit is credited under: an account's name and address. Undefined if there is no such account (it was deleted). */
export async function findUser(database: Database, id: string): Promise<{ name: string; email: string } | undefined> {
  const table = database.dialect === "postgres" ? postgresAuth.user : sqliteAuth.user;
  return dbGet<{ name: string; email: string }>(database, sql`SELECT name, email FROM ${table} WHERE id = ${id}`);
}

/**
 * The account with this exact address, for naming it in a share (DESIGN.md §12, ROADMAP 1c.2). The address is compared whole,
 * without regard to letter case, and never as a prefix or a pattern, so a lookup cannot be used to list accounts. Whether there
 * is one is for the caller to keep to itself: nothing that answers a person may differ for an address that has an account.
 */
export async function findAccountByEmail(database: Database, email: string): Promise<{ id: string; name: string; email: string } | undefined> {
  const table = database.dialect === "postgres" ? postgresAuth.user : sqliteAuth.user;
  return dbGet<{ id: string; name: string; email: string }>(database, sql`SELECT id, name, email FROM ${table} WHERE lower(email) = ${email.trim().toLowerCase()}`);
}
