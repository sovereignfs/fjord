/**
 * What the history of a repository says about what Fjord Web did (ROADMAP 2e.1): a commit message that a person reading
 * `git log` can use, where the subject says what happened to what and the body says where, and how much.
 *
 * Pure, and the one place these are written, so a message is the same whichever way the file was made or changed and each has
 * a test. Two rules hold for all of them:
 *
 *  - **The history is public to everyone who can read the repository, and an encrypted vault's contents are not.** A message
 *    about an encrypted file never carries a word of its contents, nor a size or a diff: only what its name already says (a
 *    name in a vault named by name, nothing in one named by id) and that it is encrypted. A plaintext file's title and the names
 *    of the headings that changed are in the repository anyway.
 *  - **A subject is short** (72 characters at most, cut with an ellipsis), because it is a line in a list; the detail is in the body.
 */
export interface Message {
  subject: string;
  /** Lines after the subject, a blank line between. */
  body?: string[];
}

export const SUBJECT_LIMIT = 72;
const NAMES_SHOWN = 5;
const PATHS_SHOWN = 10;

export const render = (message: Message): string => {
  const subject = clip(message.subject, SUBJECT_LIMIT);
  return message.body && message.body.length > 0
    ? `${subject}\n\n${message.body.join('\n')}`
    : subject;
};

/** At most `limit` characters, the last one an ellipsis if something was cut. */
export function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

const leaf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const parent = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const quote = (text: string) => `“${text}”`;

/** A file known by what a person calls it: its name without `.age` or `.md`. */
export const titleOf = (path: string): string =>
  leaf(path)
    .replace(/\.age$/i, '')
    .replace(/\.md$/i, '');

/** Whether a file in an encrypted vault is named by an identifier (spec §7.2) and so has no name to give. */
export const isIdName = (path: string): boolean =>
  /^[0-9a-hjkmnp-tv-z]{26}(\.age)?$/i.test(leaf(path));

const list = (names: string[], shown = NAMES_SHOWN): string =>
  names.length <= shown
    ? names.join(', ')
    : `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`;

// --- What changed in a text ------------------------------------------------------------------------------------------

/** Lines added and removed going from `before` to `after`: the shortest edit (longest common subsequence) when the texts are not huge. */
export function lineChanges(before: string[], after: string[]): { added: number; removed: number } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const a = before.slice(start, endBefore);
  const b = after.slice(start, endAfter);
  if (a.length === 0 || b.length === 0) return { added: b.length, removed: a.length };

  if (a.length * b.length <= 4_000_000) {
    // Rows of the longest-common-subsequence table, two at a time.
    let previous = new Uint32Array(b.length + 1);
    let current = new Uint32Array(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++)
        current[j] =
          a[i - 1] === b[j - 1]
            ? (previous[j - 1] as number) + 1
            : Math.max(previous[j] as number, current[j - 1] as number);
      [previous, current] = [current, previous];
    }
    const common = previous[b.length] as number;
    return { added: b.length - common, removed: a.length - common };
  }
  // Too large for the table: lines counted as a bag, which sees a moved line as unchanged and is otherwise right.
  const bag = new Map<string, number>();
  for (const line of a) bag.set(line, (bag.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of b) {
    const left = bag.get(line) ?? 0;
    if (left > 0) {
      bag.set(line, left - 1);
      common++;
    }
  }
  return { added: b.length - common, removed: a.length - common };
}

/** Words: runs of non-space characters with a letter or a digit in them, so a heading's `##` or a list's `-` is not one. */
const words = (text: string): number =>
  (text.match(/\S+/g) ?? []).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;

/** A document or note split into its header (the `---` block at the very top, if any) and its body. */
function split(text: string): { header: string; body: string } {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match
    ? { header: match[0], body: text.slice(match[0].length) }
    : { header: '', body: text };
}

const titleInHeader = (header: string): string | undefined => {
  const value = /^title:[ \t]*(.*?)[ \t]*$/m.exec(header)?.[1];
  if (value === undefined || value === '') return undefined;
  return value.replace(/^(["'])(.*)\1$/, '$2');
};

interface Section {
  name: string;
  text: string;
}

/** The parts of a body, by its headings (`#` to `######`, not inside a code fence); what is before the first heading is the introduction. */
function sections(body: string): Section[] {
  const out: Section[] = [{ name: '', text: '' }];
  let fence: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker[0] as string;
      else if (marker[0] === fence) fence = null;
    }
    const heading =
      fence === null && !marker ? /^\s{0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/.exec(line)?.[1] : undefined;
    if (heading !== undefined) out.push({ name: heading, text: `${line}\n` });
    else (out[out.length - 1] as Section).text += `${line}\n`;
  }
  return out;
}

/** Which sections were added, removed and changed; the n-th section of one name is compared with the n-th of that name. */
function sectionChanges(
  before: string,
  after: string,
): { added: string[]; removed: string[]; changed: string[] } {
  const key = (parts: Section[]) => {
    const seen = new Map<string, number>();
    return parts.map((part) => {
      const n = seen.get(part.name) ?? 0;
      seen.set(part.name, n + 1);
      return { ...part, key: `${part.name}\u0000${n}` };
    });
  };
  const was = new Map(key(sections(before)).map((part) => [part.key, part]));
  const now = key(sections(after));
  const added: string[] = [];
  const changed: string[] = [];
  const label = (name: string) => (name === '' ? 'the introduction' : name);
  for (const part of now) {
    const old = was.get(part.key);
    if (!old) added.push(label(part.name));
    else if (old.text !== part.text) changed.push(label(part.name));
    was.delete(part.key);
  }
  const removed = [...was.values()].map((part) => label(part.name));
  // The introduction is always there, so it is never added or removed, only changed.
  return {
    added: added.filter((name) => name !== 'the introduction'),
    removed: removed.filter((name) => name !== 'the introduction'),
    changed,
  };
}

// --- Messages ----------------------------------------------------------------------------------------------------------

/**
 * A version of a note or a document. `before` is the text it was made from, when it could be read: without it the message is
 * the file's name and where it is.
 */
export function editMessage(path: string, before: string | undefined, after: string): Message {
  const title = titleOf(path);
  const body: string[] = [path];
  let subject = `Edit ${quote(title)}`;
  if (before === undefined || before === after) return { subject, body };

  const was = split(before);
  const now = split(after);
  const lines = lineChanges(was.body.split(/\r?\n/), now.body.split(/\r?\n/));
  if (lines.added + lines.removed > 0) subject += ` (+${lines.added} −${lines.removed})`;

  const counts: string[] = [];
  if (lines.added + lines.removed > 0)
    counts.push(`${plural(lines.added, 'line')} added, ${lines.removed} removed`);
  const before_words = words(was.body);
  const after_words = words(now.body);
  if (before_words !== after_words) counts.push(`${before_words} → ${after_words} words`);
  if (counts.length > 0) body.push(counts.join(' · '));

  const parts = sectionChanges(was.body, now.body);
  const sectionLine = [
    parts.changed.length > 0 ? `Changed: ${list(parts.changed)}` : '',
    parts.added.length > 0 ? `Added: ${list(parts.added)}` : '',
    parts.removed.length > 0 ? `Removed: ${list(parts.removed)}` : '',
  ].filter(Boolean);
  if (sectionLine.length > 0) body.push(sectionLine.join(' · '));

  if (was.header !== now.header) {
    const from = titleInHeader(was.header);
    const to = titleInHeader(now.header);
    if (from !== to && to !== undefined)
      body.push(
        from === undefined
          ? `Titled: ${quote(clip(to, 80))}`
          : `Retitled: ${quote(clip(from, 80))} → ${quote(clip(to, 80))}`,
      );
    else if (was.header !== '' || now.header !== '') body.push('Properties changed.');
  }
  return { subject, body };
}

/** A version of an encrypted file: nothing of what changed, which would be the contents. */
export function encryptedEditMessage(path: string): Message {
  const vault = path.split('/')[0] as string;
  return {
    subject: isIdName(path)
      ? `Edit an encrypted file in ${vault}`
      : `Edit encrypted ${quote(titleOf(path))}`,
    body: [
      path,
      'Encrypted with age: the history shows that it changed, and nothing of what changed.',
    ],
  };
}

/** A file made in a plaintext vault. `text` is what it starts as. */
export function createMessage(input: { path: string; text: string }): Message {
  const { path, text } = input;
  const body = [path];
  const where = parent(path);
  const content = split(text).body;
  const header = split(text).header;
  const counts = words(content);
  body.push(
    `A new document in ${where}${counts > 0 ? `, ${plural(counts, 'word')} to start with` : ', empty to start with'}.`,
  );
  const id = /^id:[ \t]*(\S+)/m.exec(header)?.[1];
  if (id) body.push(`Document id: ${id}`);
  return { subject: `Create ${quote(titleOf(path))}`, body };
}

/** A Doc given an identifier (ROADMAP 3e.3): nothing else about it changes. */
export function identifyMessage(input: { path: string; docId: string }): Message {
  const { path, docId } = input;
  return {
    subject: `Give ${quote(titleOf(path))} an identifier`,
    body: [
      path,
      "Adds an id to the file's header, so that a link to it keeps working when it is renamed or moved.",
      `Document id: ${docId}`,
    ],
  };
}

/** A file made in an encrypted vault. */
export function createEncryptedMessage(input: { path: string }): Message {
  const { path } = input;
  const vault = path.split('/')[0] as string;
  return {
    subject: isIdName(path)
      ? `Create an encrypted file in ${vault}`
      : `Create encrypted ${quote(titleOf(path))}`,
    body: [
      path,
      `A new encrypted document in ${parent(path)}.`,
      'Encrypted with age before it left the browser: the history holds no part of its contents.',
    ],
  };
}

/** A file or a folder deleted. `paths` are the files that went. */
export function deleteMessage(input: { path: string; folder: boolean; paths: string[] }): Message {
  const { path, folder, paths } = input;
  const name = folder ? leaf(path) : titleOf(path);
  const label =
    !folder && /\.age$/i.test(path) && isIdName(path) ? 'an encrypted file' : quote(name);
  const body: string[] = [];
  if (folder) {
    body.push(`Removes ${plural(paths.length, 'file')} from ${path}:`);
    body.push(...paths.slice(0, PATHS_SHOWN).map((file) => `- ${file}`));
    if (paths.length > PATHS_SHOWN) body.push(`- and ${paths.length - PATHS_SHOWN} more`);
  } else {
    body.push(path);
  }
  body.push('Kept in this history; Fjord Web can put it back from Recently deleted.');
  return {
    subject: folder
      ? `Delete folder ${label}${paths.length > 1 ? ` (${plural(paths.length, 'file')})` : ''}`
      : `Delete ${label}`,
    body,
  };
}

/** The lines that say which files moved, for a rename or a move. */
export function movedLines(moved: { from: string; to: string }[]): string[] {
  if (moved.length === 0) return [];
  const lines = moved.slice(0, PATHS_SHOWN).map((file) => `${file.from} → ${file.to}`);
  if (moved.length > PATHS_SHOWN) lines.push(`and ${moved.length - PATHS_SHOWN} more`);
  return lines;
}
