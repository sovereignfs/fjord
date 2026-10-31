import type { Rule } from "../limits/rate";
import type { Viewer } from "./access";
import type { Author } from "./service";

/**
 * How fast comments may be written (DESIGN.md §13, §15, ROADMAP 1d.4). A write (a thread, a reply, an edit, a resolving) is counted against the
 * person who made it **and** the link it came through, because a guest's browser id is made up by the browser and a new one is free: the link is the
 * limit that cannot be evaded by changing names. Deleting is not counted (a person cleaning up after themselves is not the abuse), nor is closing.
 *
 * | holder | a minute | an hour |
 * | --- | --- | --- |
 * | an account | 30 | 600 |
 * | a guest (the link and the browser) | 20 | 200 |
 * | a link (all of its guests together) | 60 | 600 |
 *
 * The numbers are those of a person writing with care, several times over; a limit is meant to be met only by something that is not one.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const ACCOUNT: Rule[] = [{ limit: 30, windowMs: MINUTE }, { limit: 600, windowMs: HOUR }];
const GUEST: Rule[] = [{ limit: 20, windowMs: MINUTE }, { limit: 200, windowMs: HOUR }];
const LINK: Rule[] = [{ limit: 60, windowMs: MINUTE }, { limit: 600, windowMs: HOUR }];

/** Moving threads onto edited words (ROADMAP 1d.2) is the page's doing, a few at a time; this is only to stop it being used as a flood. */
export const REANCHOR_RATE: Rule = { limit: 120, windowMs: MINUTE };

const named = (holder: string, rules: Rule[]) => rules.map((rule) => ({ key: `comment:${holder}:${rule.windowMs}`, rule }));

/** What a write by `author`, who came in as `viewer`, is counted against. */
export function writeRates(viewer: Viewer, author: Author): { key: string; rule: Rule }[] {
  const person = author.kind === "account" ? named(`account:${author.id}`, ACCOUNT) : named(`guest:${author.id}`, GUEST);
  return viewer.linkId === undefined ? person : [...person, ...named(`link:${viewer.linkId}`, LINK)];
}

/** What moving a thread is counted against: the account, else the link. */
export function reanchorRates(viewer: Viewer): { key: string; rule: Rule }[] {
  const holder = viewer.account ? `account:${viewer.account.id}` : `link:${viewer.linkId ?? 0}`;
  return [{ key: `comment:reanchor:${holder}`, rule: REANCHOR_RATE }];
}
