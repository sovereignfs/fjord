// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Merging two versions of a text file, and keeping both when they cannot be
//! merged. Spec §9.1.
//!
//! Git cannot merge ciphertext and clients must not ask it to, so a client
//! decrypts both sides and their merge base, merges the plaintext, and
//! re-encrypts the result. `fjord sync` did the merging by running
//! `git merge-file`; a client with no `git` binary (the web client, a phone)
//! cannot. This is the same merge in pure Rust, so every client produces the
//! same result: [`merge3`] merges three texts by lines; [`conflict_copy_path`]
//! and [`conflict_copy_text`] say where and how the losing side is kept when
//! it cannot be merged (§9.1: neither side is ever discarded); and
//! [`add_add`] settles two files added at one path.
//!
//! # How [`merge3`] merges
//!
//! The lines are the unit, each with its line ending, so a file with and a
//! file without a final newline differ in their last line, as they do to
//! git. The base is compared with each side, and the changes are walked in
//! order:
//!
//! - a change on one side only is taken;
//! - changes on both sides that **overlap or touch** (one ends where the
//!   other begins) are one region, as they are for `git merge-file`: if the
//!   sides made the same change there, it is taken once; otherwise it is a
//!   [`Hunk::Conflict`], never guessed at.
//!
//! The classification (clean or conflicted) and the text of a clean merge
//! are the ones `git merge-file` gives, which `fjord-cli`'s tests check
//! against the real `git` over a corpus. Where the lines of a file repeat so
//! much that there are several equally short ways to compare it with its
//! base, git may choose a different one, and the two can then disagree about
//! a change near the repeats; a conflict is always the cautious answer.
//!
//! A pure function: no filesystem, no clock, no randomness (the caller
//! supplies the fresh `id` a conflict copy gets).

use crate::doc;
use crate::naming::free_name;
use crate::path::to_nfc;
use std::collections::HashMap;

/// The most steps of difference between a side and the base that are looked
/// for. Past it the lines between the common beginning and end of the two
/// are taken to have all changed, which only ever makes for a conflict, never
/// for a lost change. Bounds the memory of one comparison to a few million
/// numbers.
const MAX_EDIT_DISTANCE: usize = 2_000;

/// The longest a path component may be. Spec §5 rule 5.
const MAX_COMPONENT_BYTES: usize = crate::path::MAX_COMPONENT_BYTES;

// --- Merging text --------------------------------------------------------------------------------------------

/// One stretch of a merge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Hunk {
    /// Text that is settled: unchanged, changed on one side only, or changed
    /// the same way on both.
    Resolved(String),
    /// Both sides changed the same lines, differently.
    Conflict(Conflict),
}

/// What the base, ours and theirs each have where they cannot be merged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conflict {
    pub base: String,
    pub ours: String,
    pub theirs: String,
}

/// The result of [`merge3`]: the whole text, in order, as settled stretches
/// and conflicts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Merge {
    pub hunks: Vec<Hunk>,
}

impl Merge {
    /// Whether there is nothing left to decide.
    pub fn is_clean(&self) -> bool {
        self.conflicts() == 0
    }

    /// How many conflicts there are.
    pub fn conflicts(&self) -> usize {
        self.hunks
            .iter()
            .filter(|hunk| matches!(hunk, Hunk::Conflict(_)))
            .count()
    }

    /// The merged text, when it merged cleanly.
    pub fn clean_text(&self) -> Option<String> {
        if !self.is_clean() {
            return None;
        }
        Some(
            self.hunks
                .iter()
                .map(|hunk| match hunk {
                    Hunk::Resolved(text) => text.as_str(),
                    Hunk::Conflict(_) => "",
                })
                .collect(),
        )
    }

    /// The text with each conflict written between markers, as
    /// `git merge-file` writes it, for showing a person what to decide. A
    /// side's text that lacks a final newline gets one before the marker
    /// that follows it, so a marker always starts a line.
    pub fn with_markers(&self, ours_label: &str, theirs_label: &str) -> String {
        let mut out = String::new();
        for hunk in &self.hunks {
            match hunk {
                Hunk::Resolved(text) => out.push_str(text),
                Hunk::Conflict(conflict) => {
                    out.push_str(&format!("<<<<<<< {ours_label}\n"));
                    push_line_terminated(&mut out, &conflict.ours);
                    out.push_str("=======\n");
                    push_line_terminated(&mut out, &conflict.theirs);
                    out.push_str(&format!(">>>>>>> {theirs_label}\n"));
                }
            }
        }
        out
    }
}

fn push_line_terminated(out: &mut String, text: &str) {
    out.push_str(text);
    if !text.is_empty() && !text.ends_with('\n') {
        out.push('\n');
    }
}

/// Merge `ours` and `theirs`, two edits of `base`. See the module
/// documentation for what is a conflict.
pub fn merge3(base: &str, ours: &str, theirs: &str) -> Merge {
    // The cases that need no comparison, and the ones the answer is plain in.
    if ours == theirs {
        return resolved(ours);
    }
    if base == ours {
        return resolved(theirs);
    }
    if base == theirs {
        return resolved(ours);
    }

    // One numbering of the distinct lines for all three, so that comparing
    // lines is comparing numbers.
    let mut numbers: HashMap<&str, u32> = HashMap::new();
    let base_numbers = number_lines(&mut numbers, base);
    let ours_numbers = number_lines(&mut numbers, ours);
    let theirs_numbers = number_lines(&mut numbers, theirs);

    let base_lines = split_lines(base);
    let ours_lines = split_lines(ours);
    let theirs_lines = split_lines(theirs);

    let ours_changes = changes(&base_numbers, &ours_numbers);
    let theirs_changes = changes(&base_numbers, &theirs_numbers);

    let mut hunks: Vec<Hunk> = Vec::new();
    let mut settled = String::new();
    let mut cursor = 0; // the next base line not yet written
    let (mut i, mut j) = (0, 0); // the next change on each side
    let (mut ours_shift, mut theirs_shift) = (0isize, 0isize);

    while i < ours_changes.len() || j < theirs_changes.len() {
        // The earlier of the two next changes starts a region.
        let take_ours = match (ours_changes.get(i), theirs_changes.get(j)) {
            (Some(a), Some(b)) => a.base_start <= b.base_start,
            (Some(_), None) => true,
            _ => false,
        };
        let (ours_before, theirs_before) = (ours_shift, theirs_shift);
        let (mut from_ours, mut from_theirs) = (false, false);

        // The region starts with that change, which is in it whatever else touches it.
        let (start, mut end);
        if take_ours {
            let first = ours_changes[i];
            (start, end) = (first.base_start, first.base_end());
            ours_shift += first.shift();
            from_ours = true;
            i += 1;
        } else {
            let first = theirs_changes[j];
            (start, end) = (first.base_start, first.base_end());
            theirs_shift += first.shift();
            from_theirs = true;
            j += 1;
        }

        // Grow the region over every change that overlaps or touches it,
        // from either side.
        loop {
            let mut grew = false;
            if let Some(change) = ours_changes.get(i) {
                if change.base_start <= end {
                    end = end.max(change.base_end());
                    ours_shift += change.shift();
                    from_ours = true;
                    i += 1;
                    grew = true;
                }
            }
            if let Some(change) = theirs_changes.get(j) {
                if change.base_start <= end {
                    end = end.max(change.base_end());
                    theirs_shift += change.shift();
                    from_theirs = true;
                    j += 1;
                    grew = true;
                }
            }
            if !grew {
                break;
            }
        }

        // Base lines nobody touched, up to the region.
        settled.push_str(&base_lines[cursor..start].concat());
        cursor = end;

        let range = |lines: &[&str], before: isize, after: isize| -> String {
            let from = (start as isize + before) as usize;
            let to = (end as isize + after) as usize;
            lines[from..to].concat()
        };
        let ours_text = range(&ours_lines, ours_before, ours_shift);
        let theirs_text = range(&theirs_lines, theirs_before, theirs_shift);

        match (from_ours, from_theirs) {
            (true, false) => settled.push_str(&ours_text),
            (false, true) => settled.push_str(&theirs_text),
            _ if ours_text == theirs_text => settled.push_str(&ours_text),
            _ => {
                if !settled.is_empty() {
                    hunks.push(Hunk::Resolved(std::mem::take(&mut settled)));
                }
                hunks.push(Hunk::Conflict(Conflict {
                    base: base_lines[start..end].concat(),
                    ours: ours_text,
                    theirs: theirs_text,
                }));
            }
        }
    }

    settled.push_str(&base_lines[cursor..].concat());
    if !settled.is_empty() || hunks.is_empty() {
        hunks.push(Hunk::Resolved(settled));
    }
    Merge { hunks }
}

fn resolved(text: &str) -> Merge {
    Merge {
        hunks: vec![Hunk::Resolved(text.to_string())],
    }
}

/// The lines of `text` as numbers, the same line the same number in every text numbered with one `numbers`.
fn number_lines<'a>(numbers: &mut HashMap<&'a str, u32>, text: &'a str) -> Vec<u32> {
    split_lines(text)
        .into_iter()
        .map(|line| {
            let next = numbers.len() as u32;
            *numbers.entry(line).or_insert(next)
        })
        .collect()
}

/// The lines of `text`, each with its line ending. Only `\n` ends a line, so
/// a `\r` stays with the line it is on, as it does for git.
fn split_lines(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').collect()
}

// --- Comparing --------------------------------------------------------------------------------------------

/// One stretch where a side differs from the base: `base_len` base lines
/// from `base_start` became `side_len` lines of the side.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Change {
    base_start: usize,
    base_len: usize,
    side_len: usize,
}

impl Change {
    fn base_end(&self) -> usize {
        self.base_start + self.base_len
    }

    /// How much later in the side than in the base the lines after it are.
    fn shift(&self) -> isize {
        self.side_len as isize - self.base_len as isize
    }
}

/// The stretches where `side` differs from `base`, in order, with nothing
/// between two of them that the two have in common.
fn changes(base: &[u32], side: &[u32]) -> Vec<Change> {
    let prefix = base
        .iter()
        .zip(side)
        .take_while(|(left, right)| left == right)
        .count();
    let suffix = base[prefix..]
        .iter()
        .rev()
        .zip(side[prefix..].iter().rev())
        .take_while(|(left, right)| left == right)
        .count();
    let base_middle = &base[prefix..base.len() - suffix];
    let side_middle = &side[prefix..side.len() - suffix];

    let steps = match shortest_edit(base_middle, side_middle) {
        Some(steps) => steps,
        // Too different to compare closely: the whole middle changed.
        None => {
            return if base_middle.is_empty() && side_middle.is_empty() {
                Vec::new()
            } else {
                vec![Change {
                    base_start: prefix,
                    base_len: base_middle.len(),
                    side_len: side_middle.len(),
                }]
            }
        }
    };

    let mut out: Vec<Change> = Vec::new();
    let mut base_at = prefix;
    let mut open: Option<Change> = None;
    for step in steps {
        match step {
            Step::Same => {
                out.extend(open.take());
                base_at += 1;
            }
            Step::Delete => {
                let change = open.get_or_insert(Change {
                    base_start: base_at,
                    base_len: 0,
                    side_len: 0,
                });
                change.base_len += 1;
                base_at += 1;
            }
            Step::Insert => {
                let change = open.get_or_insert(Change {
                    base_start: base_at,
                    base_len: 0,
                    side_len: 0,
                });
                change.side_len += 1;
            }
        }
    }
    out.extend(open);
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    Same,
    Delete,
    Insert,
}

/// A shortest edit script from `a` to `b` (Myers, "An O(ND) Difference
/// Algorithm", 1986), or `None` if it is longer than [`MAX_EDIT_DISTANCE`].
fn shortest_edit(a: &[u32], b: &[u32]) -> Option<Vec<Step>> {
    let (n, m) = (a.len() as isize, b.len() as isize);
    if n == 0 && m == 0 {
        return Some(Vec::new());
    }
    let max = ((n + m) as usize).min(MAX_EDIT_DISTANCE) as isize;
    let offset = max + 1;
    let mut v = vec![0isize; (2 * max + 3) as usize];
    // `v` as it was at the start of each round, trimmed to the diagonals
    // that round can reach.
    let mut trace: Vec<Vec<isize>> = Vec::new();

    let mut found = None;
    'rounds: for d in 0..=max {
        trace.push(v[(offset - d - 1) as usize..=(offset + d + 1) as usize].to_vec());
        let mut k = -d;
        while k <= d {
            let mut x = if k == -d
                || (k != d && v[(offset + k - 1) as usize] < v[(offset + k + 1) as usize])
            {
                v[(offset + k + 1) as usize]
            } else {
                v[(offset + k - 1) as usize] + 1
            };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[(offset + k) as usize] = x;
            if x >= n && y >= m {
                found = Some(d);
                break 'rounds;
            }
            k += 2;
        }
    }
    let distance = found?;

    // Walk back from the end through the rounds.
    let mut steps: Vec<Step> = Vec::new();
    let (mut x, mut y) = (n, m);
    for d in (1..=distance).rev() {
        let round = &trace[d as usize];
        let at = |k: isize| round[(k + d + 1) as usize];
        let k = x - y;
        let previous = if k == -d || (k != d && at(k - 1) < at(k + 1)) {
            k + 1
        } else {
            k - 1
        };
        let previous_x = at(previous);
        let previous_y = previous_x - previous;
        while x > previous_x && y > previous_y {
            steps.push(Step::Same);
            x -= 1;
            y -= 1;
        }
        steps.push(if x == previous_x {
            Step::Insert
        } else {
            Step::Delete
        });
        x = previous_x;
        y = previous_y;
    }
    while x > 0 && y > 0 {
        steps.push(Step::Same);
        x -= 1;
        y -= 1;
    }
    steps.reverse();
    Some(steps)
}

// --- Keeping both sides ----------------------------------------------------------------------------------

/// How a file is split into what names it and how it ends: `.fj.md` is one
/// extension (a document; spec §8.4), otherwise the last `.`, if it is not
/// the first character.
pub(crate) fn split_extension(name: &str) -> (&str, &str) {
    if let Some(stem) = name.strip_suffix(doc::DOCUMENT_SUFFIX) {
        if !stem.is_empty() {
            return (stem, &name[stem.len()..]);
        }
    }
    match name.rfind('.') {
        Some(at) if at > 0 => (&name[..at], &name[at..]),
        _ => (name, ""),
    }
}

/// Where the side that could not be merged is kept: beside the original,
/// `report.conflict-4t6yhb2k.md` for `report.md` and a fresh `id` ending in
/// `4t6yhb2k`. Spec §9.1 says to keep both; this is the name of the second.
///
/// `path` is the repository-relative path of the file as it is on disk and
/// `suffix` the encryption suffix of its vault (`".age"`, or `""` for a
/// plaintext vault), which stays last. A document keeps `.fj.md` (so it stays
/// a document), the stem is shortened if the name would pass 255 bytes
/// (spec §5 rule 5), and `existing`, the names in that folder, is respected
/// case-insensitively: a taken name gets `-2`, `-3`, … after the id.
pub fn conflict_copy_path<S: AsRef<str>>(
    path: &str,
    suffix: &str,
    id: &str,
    existing: &[S],
) -> String {
    let (directory, name) = match path.rfind('/') {
        Some(at) => (&path[..=at], &path[at + 1..]),
        None => ("", path),
    };
    let logical = name.strip_suffix(suffix).unwrap_or(name);
    let (stem, extension) = split_extension(logical);
    let short = &id[id.len().saturating_sub(8)..];

    let taken: std::collections::HashSet<String> = existing
        .iter()
        .map(|name| to_nfc(name.as_ref()).to_lowercase())
        .collect();
    let build = |number: usize| -> String {
        let tail = if number == 1 {
            format!(".conflict-{short}{extension}{suffix}")
        } else {
            format!(".conflict-{short}-{number}{extension}{suffix}")
        };
        // Shorten the stem, on a character boundary, to leave room for the tail.
        let room = MAX_COMPONENT_BYTES.saturating_sub(tail.len());
        let mut end = stem.len().min(room);
        while !stem.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}{tail}", &stem[..end])
    };
    let chosen = (1..)
        .map(build)
        .find(|candidate| !taken.contains(&to_nfc(candidate).to_lowercase()))
        .unwrap_or_default();
    format!("{directory}{chosen}")
}

/// `theirs` as the Doc it is kept as: with `id` as its `id`, so that keeping
/// it does not make two files share one (`E401`). A file that is not a Doc
/// has no `id` to change and is returned as it is.
pub fn conflict_copy_text(theirs: &str, id: &str) -> String {
    doc::with_fresh_id(theirs, id).unwrap_or_else(|| theirs.to_string())
}

/// What to do with two files added at one path, one on each side, with no
/// base.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AddAdd {
    /// The same file twice: keep it once.
    Same,
    /// The same Doc (one `id`) written twice differently, as when a file is
    /// copied and edited on two devices: a real conflict. Merge the two
    /// with an empty base ([`merge3`]), and keep both if that conflicts.
    SameDocument,
    /// Two different files that were given the same name, as two phones that
    /// each captured "Buy milk" while offline. They are not versions of one
    /// document and there is nothing to merge. Keep **theirs** where it is,
    /// since others have seen it there, and move **ours**, which has not
    /// been pushed, to `ours_path`: the next free number after the name.
    Distinct { ours_path: String },
}

/// Settle two files added at `path`. `existing` is the names in that folder
/// (the name at `path` is counted whether or not it is listed).
pub fn add_add<S: AsRef<str>>(path: &str, ours: &str, theirs: &str, existing: &[S]) -> AddAdd {
    if ours == theirs {
        return AddAdd::Same;
    }
    let id_of = |text: &str| match doc::parse(text) {
        doc::Parse::Present { frontmatter, .. } => frontmatter.doc_id().map(str::to_string),
        _ => None,
    };
    if let (Some(a), Some(b)) = (id_of(ours), id_of(theirs)) {
        if a == b {
            return AddAdd::SameDocument;
        }
    }

    let (directory, name) = match path.rfind('/') {
        Some(at) => (&path[..=at], &path[at + 1..]),
        None => ("", path),
    };
    let (stem, extension) = split_extension(name);
    let mut names: Vec<&str> = existing.iter().map(AsRef::as_ref).collect();
    names.push(name);
    AddAdd::Distinct {
        ours_path: format!("{directory}{}", free_name(stem, extension, &names)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: &[&str] = &[];

    fn lines(n: usize) -> String {
        (1..=n).map(|i| format!("line {i}\n")).collect()
    }

    fn clean(base: &str, ours: &str, theirs: &str) -> String {
        merge3(base, ours, theirs)
            .clean_text()
            .unwrap_or_else(|| panic!("expected a clean merge of {base:?} {ours:?} {theirs:?}"))
    }

    fn conflicted(base: &str, ours: &str, theirs: &str) -> Merge {
        let merge = merge3(base, ours, theirs);
        assert!(!merge.is_clean(), "expected a conflict in {merge:?}");
        merge
    }

    // --- merge3 ---

    #[test]
    fn nothing_changed_or_one_side_changed() {
        assert_eq!(clean("a\nb\n", "a\nb\n", "a\nb\n"), "a\nb\n");
        assert_eq!(clean("a\nb\n", "a\nB\n", "a\nb\n"), "a\nB\n");
        assert_eq!(clean("a\nb\n", "a\nb\n", "a\nB\n"), "a\nB\n");
        assert_eq!(clean("", "x\n", "x\n"), "x\n");
        assert_eq!(clean("", "", ""), "");
    }

    #[test]
    fn changes_in_different_places_both_apply() {
        let base = lines(10);
        let ours = base.replace("line 2\n", "ours 2\n");
        let theirs = base.replace("line 8\n", "theirs 8\n");
        let expected = base
            .replace("line 2\n", "ours 2\n")
            .replace("line 8\n", "theirs 8\n");
        assert_eq!(clean(&base, &ours, &theirs), expected);
    }

    #[test]
    fn insertions_and_deletions_in_different_places_both_apply() {
        let base = lines(10);
        let ours = base.replace("line 3\n", "line 3\nadded by ours\n");
        let theirs = base.replace("line 8\n", "");
        let expected = base
            .replace("line 3\n", "line 3\nadded by ours\n")
            .replace("line 8\n", "");
        assert_eq!(clean(&base, &ours, &theirs), expected);
    }

    #[test]
    fn the_same_change_on_both_sides_is_taken_once() {
        let base = lines(5);
        let both = base.replace("line 3\n", "same\n");
        assert_eq!(clean(&base, &both, &both), both);
        // Also when each side made it alongside a different change elsewhere.
        let ours = both.replace("line 1\n", "ours 1\n");
        let theirs = both.replace("line 5\n", "theirs 5\n");
        assert_eq!(
            clean(&base, &ours, &theirs),
            both.replace("line 1\n", "ours 1\n")
                .replace("line 5\n", "theirs 5\n")
        );
    }

    #[test]
    fn different_changes_to_the_same_lines_conflict() {
        let base = lines(5);
        let ours = base.replace("line 3\n", "ours\n");
        let theirs = base.replace("line 3\n", "theirs\n");
        let merge = conflicted(&base, &ours, &theirs);
        assert_eq!(merge.conflicts(), 1);
        match &merge.hunks[1] {
            Hunk::Conflict(c) => {
                assert_eq!(c.base, "line 3\n");
                assert_eq!(c.ours, "ours\n");
                assert_eq!(c.theirs, "theirs\n");
            }
            other => panic!("{other:?}"),
        }
        assert!(merge.clean_text().is_none());
    }

    #[test]
    fn a_change_and_a_deletion_of_the_same_line_conflict() {
        let base = lines(5);
        conflicted(
            &base,
            &base.replace("line 3\n", "changed\n"),
            &base.replace("line 3\n", ""),
        );
    }

    #[test]
    fn changes_that_touch_conflict_as_they_do_for_git() {
        // Ours changes line 2, theirs line 3: next to each other, nothing between them.
        let base = lines(5);
        let ours = base.replace("line 2\n", "ours\n");
        let theirs = base.replace("line 3\n", "theirs\n");
        conflicted(&base, &ours, &theirs);
        // With a line between them, they merge.
        let theirs = base.replace("line 4\n", "theirs\n");
        assert_eq!(
            clean(&base, &ours, &theirs),
            base.replace("line 2\n", "ours\n")
                .replace("line 4\n", "theirs\n")
        );
    }

    #[test]
    fn changes_that_touch_conflict_whichever_side_comes_first() {
        let base = lines(6);
        // The earlier change ends where the later one begins: line 2 changed, deleted, or followed by an
        // insertion (all end at the start of line 3), and line 3 changed, deleted, or preceded by one.
        let earlier = |text: &str| base.replace("line 2\n", text);
        let later = |text: &str| base.replace("line 3\n", text);
        for before in ["X\n", "", "line 2\nX\n"] {
            for after in ["Y\n", "", "Y\nline 3\n"] {
                conflicted(&base, &earlier(before), &later(after));
                conflicted(&base, &later(after), &earlier(before));
            }
        }
        // One line apart, they merge, in either order.
        let apart = base.replace("line 4\n", "Z\n");
        let merged = base.replace("line 2\n", "X\n").replace("line 4\n", "Z\n");
        assert_eq!(clean(&base, &earlier("X\n"), &apart), merged);
        assert_eq!(clean(&base, &apart, &earlier("X\n")), merged);
    }

    #[test]
    fn two_different_insertions_at_one_place_conflict() {
        let base = lines(3);
        let ours = base.replace("line 2\n", "line 2\nours\n");
        let theirs = base.replace("line 2\n", "line 2\ntheirs\n");
        conflicted(&base, &ours, &theirs);
        // The same insertion is taken once.
        assert_eq!(clean(&base, &ours, &ours), ours);
    }

    #[test]
    fn a_conflict_among_clean_changes_leaves_the_rest_merged() {
        let base = lines(20);
        let ours = base
            .replace("line 2\n", "ours 2\n")
            .replace("line 10\n", "ours 10\n");
        let theirs = base
            .replace("line 10\n", "theirs 10\n")
            .replace("line 18\n", "theirs 18\n");
        let merge = conflicted(&base, &ours, &theirs);
        assert_eq!(merge.conflicts(), 1);
        let marked = merge.with_markers("ours", "theirs");
        assert!(marked.contains("ours 2\n"), "{marked}");
        assert!(marked.contains("theirs 18\n"), "{marked}");
        assert!(
            marked.contains("<<<<<<< ours\nours 10\n=======\ntheirs 10\n>>>>>>> theirs\n"),
            "{marked}"
        );
    }

    #[test]
    fn the_final_newline_is_part_of_the_last_line() {
        // One side adds the newline, the other edits the line: they changed the same line.
        conflicted("a\nb", "a\nb\n", "a\nB");
        // Neither touches the last line.
        assert_eq!(clean("a\nb\nc", "A\nb\nc", "a\nb\nC"), "A\nb\nC");
        // Appending after a last line that has no newline changes that line too.
        conflicted("a\nb", "a\nb\nc\n", "a\nB");
    }

    #[test]
    fn carriage_returns_stay_with_their_lines() {
        let base = "a\r\nb\r\nc\r\n";
        assert_eq!(
            clean(base, "A\r\nb\r\nc\r\n", "a\r\nb\r\nC\r\n"),
            "A\r\nb\r\nC\r\n"
        );
    }

    #[test]
    fn markers_start_a_line_even_after_text_with_no_final_newline() {
        let merge = conflicted("x", "ours", "theirs");
        assert_eq!(
            merge.with_markers("a", "b"),
            "<<<<<<< a\nours\n=======\ntheirs\n>>>>>>> b\n"
        );
    }

    #[test]
    fn a_text_nowhere_near_its_base_is_a_conflict_not_a_lost_change() {
        let base: String = (0..3_000).map(|i| format!("base {i}\n")).collect();
        let ours: String = (0..3_000).map(|i| format!("ours {i}\n")).collect();
        let theirs: String = (0..3_000).map(|i| format!("theirs {i}\n")).collect();
        let merge = conflicted(&base, &ours, &theirs);
        match &merge.hunks[..] {
            [Hunk::Conflict(c)] => {
                assert_eq!(c.ours, ours);
                assert_eq!(c.theirs, theirs);
                assert_eq!(c.base, base);
            }
            other => panic!("{} hunks", other.len()),
        }
        // But one side being far from the base and the other unchanged is still its change.
        assert_eq!(clean(&base, &ours, &base), ours);
    }

    #[test]
    fn no_line_is_ever_lost() {
        // Whatever the result, a clean merge contains every line each side added.
        let base = lines(30);
        let ours = base
            .replace("line 5\n", "o1\no2\n")
            .replace("line 25\n", "");
        let theirs = base
            .replace("line 15\n", "t1\n")
            .replace("line 29\n", "line 29\nt2\n");
        let text = clean(&base, &ours, &theirs);
        for wanted in ["o1\n", "o2\n", "t1\n", "t2\n"] {
            assert!(text.contains(wanted), "{wanted:?} missing from {text}");
        }
        assert!(!text.contains("line 25\n"));
    }

    // --- Keeping both sides ---

    const ID: &str = "01jagc4k7pt8y3wqnmzv5xrb8j";

    #[test]
    fn a_conflict_copy_name() {
        let id = "01jagc4k7pt8y3wqnmzv5xrb8j";
        // The last eight characters of the id.
        assert_eq!(
            conflict_copy_path("report.md", "", id, NONE),
            "report.conflict-zv5xrb8j.md"
        );
        assert_eq!(
            conflict_copy_path("Projects/Fjord/notes.md", "", id, NONE),
            "Projects/Fjord/notes.conflict-zv5xrb8j.md"
        );
        assert_eq!(
            conflict_copy_path("README", "", id, NONE),
            "README.conflict-zv5xrb8j"
        );
        assert_eq!(
            conflict_copy_path(".hidden", "", id, NONE),
            ".hidden.conflict-zv5xrb8j"
        );
        assert_eq!(
            conflict_copy_path("archive.tar.gz", "", id, NONE),
            "archive.tar.conflict-zv5xrb8j.gz"
        );
    }

    #[test]
    fn a_document_stays_a_document() {
        let id = "01jagc4k7pt8y3wqnmzv5xrb8j";
        assert_eq!(
            conflict_copy_path("plan.fj.md", "", id, NONE),
            "plan.conflict-zv5xrb8j.fj.md"
        );
        assert!(doc::is_document_name(&conflict_copy_path(
            "plan.fj.md",
            "",
            id,
            NONE
        )));
        // `.fj.md` alone has no stem to be a document by: it is a name with the extension `.md`.
        assert_eq!(
            conflict_copy_path(".fj.md", "", id, NONE),
            ".fj.conflict-zv5xrb8j.md"
        );
    }

    #[test]
    fn an_encryption_suffix_stays_last() {
        let id = "01jagc4k7pt8y3wqnmzv5xrb8j";
        assert_eq!(
            conflict_copy_path("Private/notes.md.age", ".age", id, NONE),
            "Private/notes.conflict-zv5xrb8j.md.age"
        );
        assert_eq!(
            conflict_copy_path("Private/plan.fj.md.age", ".age", id, NONE),
            "Private/plan.conflict-zv5xrb8j.fj.md.age"
        );
    }

    #[test]
    fn a_conflict_copy_name_is_kept_under_255_bytes() {
        let id = "01jagc4k7pt8y3wqnmzv5xrb8j";
        let long = format!("{}.md", "a".repeat(250));
        let named = conflict_copy_path(&long, "", id, NONE);
        assert!(named.len() <= 255, "{}", named.len());
        assert!(named.ends_with(".conflict-zv5xrb8j.md"));
        // Not through the middle of a character.
        let wide = format!("{}.md", "漢".repeat(84));
        let named = conflict_copy_path(&wide, "", id, NONE);
        assert!(
            named.len() <= 255 && named.ends_with(".md"),
            "{}",
            named.len()
        );
        assert!(crate::path::check_component(&named).is_empty());
    }

    #[test]
    fn a_taken_conflict_copy_name_is_numbered() {
        let id = "01jagc4k7pt8y3wqnmzv5xrb8j";
        let first = conflict_copy_path("a.md", "", id, NONE);
        assert_eq!(
            conflict_copy_path("a.md", "", id, std::slice::from_ref(&first)),
            "a.conflict-zv5xrb8j-2.md"
        );
        assert_eq!(
            conflict_copy_path(
                "a.md",
                "",
                id,
                &[first.to_uppercase(), "a.conflict-zv5xrb8j-2.md".to_string()]
            ),
            "a.conflict-zv5xrb8j-3.md"
        );
    }

    #[test]
    fn a_conflict_copy_gets_the_fresh_id_and_keeps_everything_else() {
        let theirs =
            "---\nid: 01jagc4k7pt8y3wqnmzv5xrb8k\ntitle: Plan\ncustom: kept\n---\n\n# Plan\n";
        let copy = conflict_copy_text(theirs, ID);
        assert!(copy.contains(&format!("id: {ID}")), "{copy}");
        assert!(!copy.contains("xrb8k"));
        assert!(copy.contains("custom: kept") && copy.ends_with("# Plan\n"));
        // Not a Doc: no id to change, returned as it is.
        assert_eq!(conflict_copy_text("just text\n", ID), "just text\n");
    }

    // --- add/add ---

    const DOC_A: &str = "---\nid: 01jagc4k7pt8y3wqnmzv5xrb8a\n---\nBuy milk\n";
    const DOC_B: &str = "---\nid: 01jagc4k7pt8y3wqnmzv5xrb8b\n---\nBuy milk and eggs\n";

    #[test]
    fn two_identical_files_are_one() {
        assert_eq!(
            add_add("Inbox/Buy milk.md", DOC_A, DOC_A, NONE),
            AddAdd::Same
        );
    }

    #[test]
    fn two_notes_with_one_name_are_both_kept_and_ours_moves() {
        assert_eq!(
            add_add("Inbox/Buy milk.md", DOC_A, DOC_B, &["Buy milk.md"]),
            AddAdd::Distinct {
                ours_path: "Inbox/Buy milk 2.md".to_string()
            }
        );
        // The next free number, case-insensitively.
        assert_eq!(
            add_add(
                "Inbox/Buy milk.md",
                DOC_A,
                DOC_B,
                &["BUY MILK 2.md", "Buy milk 3.md"]
            ),
            AddAdd::Distinct {
                ours_path: "Inbox/Buy milk 4.md".to_string()
            }
        );
        assert_eq!(
            add_add("Buy milk.md", "plain text\n", "other plain text\n", NONE),
            AddAdd::Distinct {
                ours_path: "Buy milk 2.md".to_string()
            }
        );
    }

    #[test]
    fn a_document_keeps_its_extension_when_it_moves() {
        let a = DOC_A;
        let b = DOC_B;
        assert_eq!(
            add_add("plan.fj.md", a, b, NONE),
            AddAdd::Distinct {
                ours_path: "plan 2.fj.md".to_string()
            }
        );
    }

    #[test]
    fn one_id_written_twice_is_the_same_document() {
        let edited = DOC_A.replace("Buy milk", "Buy oat milk");
        assert_eq!(
            add_add("Buy milk.md", DOC_A, &edited, NONE),
            AddAdd::SameDocument
        );
    }
}
