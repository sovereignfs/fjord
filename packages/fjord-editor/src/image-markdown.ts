// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The Markdown for a picture: `![alt](reference)`. The alt text cannot end itself early (`[`, `]` and `\` are escaped, a line break is a space) and a
 * reference that holds a space or a bracket is written in angle brackets, so that nothing a name holds can end the link or start another.
 */
export function imageMarkdown(reference: string, alt: string): string {
  const words = alt.replace(/\s+/g, " ").trim().replace(/[\\[\]]/g, (c) => `\\${c}`);
  const plain = reference.replace(/[\r\n]/g, "");
  const destination = /[\s()<>]/.test(plain) ? `<${plain.replace(/[<>]/g, "")}>` : plain;
  return `![${words}](${destination})`;
}

/** The pictures among files a person pasted or dropped, by the type the browser gave them. The host checks what they really are. */
export function pictureFiles(files: ArrayLike<File> | null | undefined): File[] {
  return Array.from(files ?? []).filter((file) => file.type.startsWith("image/"));
}
