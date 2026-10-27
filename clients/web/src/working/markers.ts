/**
 * Whether a text still has a conflict between markers in it, as a combine writes one (`<<<<<<< name`, `=======`,
 * `>>>>>>> name`, each on a line of its own). A note may say such lines for its own reasons, so this only asks the person to
 * look before a version is saved; it never refuses one.
 */
export function hasConflictMarkers(text: string): boolean {
  return /^<<<<<<< /m.test(text) && /^=======\r?$/m.test(text) && /^>>>>>>> /m.test(text);
}
