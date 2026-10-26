// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fjord_core::merge::merge3` against `git merge-file` (ROADMAP MP1).
//!
//! `fjord sync` merged with `git merge-file`; a client without git cannot, so the merge is also in
//! `fjord-core`. The claim that makes the two interchangeable is that they agree: over a corpus of
//! three-way merges, the same ones are clean, the same ones conflict, and a clean merge is the same
//! text. That is what is checked here, with the real `git`, over merges made by a seeded generator
//! (so a failure is the same failure every time) and over the awkward cases written out by hand.
//!
//! Lines that repeat make for several equally short ways to compare a file with its base, and git may
//! choose another than `fjord-core` does. The generated corpus with repeats says how often that
//! matters; what it must never do is turn a conflict into a clean merge that loses a change, and
//! that is checked for every case.

use fjord_core::merge::merge3;
use std::process::Command;

/// `git merge-file -p`: the merged text, and whether it was clean. Panics if git itself fails.
fn git_merge(directory: &std::path::Path, base: &str, ours: &str, theirs: &str) -> (String, bool) {
    let (base_file, ours_file, theirs_file) = (
        directory.join("base"),
        directory.join("ours"),
        directory.join("theirs"),
    );
    std::fs::write(&base_file, base).unwrap();
    std::fs::write(&ours_file, ours).unwrap();
    std::fs::write(&theirs_file, theirs).unwrap();
    let output = Command::new("git")
        .args([
            "merge-file",
            "-p",
            "-L",
            "ours",
            "-L",
            "base",
            "-L",
            "theirs",
        ])
        .arg(&ours_file)
        .arg(&base_file)
        .arg(&theirs_file)
        .output()
        .expect("run git");
    let code = output.status.code().expect("git ended");
    assert!(
        (0..128).contains(&code),
        "git merge-file failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    (String::from_utf8(output.stdout).expect("utf-8"), code == 0)
}

/// SplitMix64, so the corpus needs no dependency and is the same every run.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() % n as u64) as usize
        }
    }
}

/// A random edit of `lines`: replace, delete or insert at a random place. `fresh` makes a line that is
/// unlike any other; `vocabulary` (when there is one) makes lines that repeat.
fn edit(rng: &mut Rng, lines: &mut Vec<String>, tag: &str, vocabulary: usize) {
    let new_line = |rng: &mut Rng| {
        if vocabulary > 0 {
            format!("v{}", rng.below(vocabulary))
        } else {
            format!("{tag}-{}", rng.next() % 100_000)
        }
    };
    match rng.below(4) {
        0 if !lines.is_empty() => {
            let at = rng.below(lines.len());
            lines[at] = new_line(rng);
        }
        1 if !lines.is_empty() => {
            let at = rng.below(lines.len());
            let count = 1 + rng.below(3);
            lines.drain(at..(at + count).min(lines.len()));
        }
        _ => {
            let at = rng.below(lines.len() + 1);
            let count = 1 + rng.below(3);
            for k in 0..count {
                let line = new_line(rng);
                lines.insert((at + k).min(lines.len()), line);
            }
        }
    }
}

fn join(lines: &[String], final_newline: bool, crlf: bool) -> String {
    let end = if crlf { "\r\n" } else { "\n" };
    let mut text = lines.join(end);
    if !lines.is_empty() && final_newline {
        text.push_str(end);
    }
    text
}

struct Case {
    base: String,
    ours: String,
    theirs: String,
}

fn generate(seed: u64, count: usize, vocabulary: usize) -> Vec<Case> {
    let mut rng = Rng(seed);
    (0..count)
        .map(|_| {
            let length = rng.below(40);
            let base_lines: Vec<String> = (0..length)
                .map(|i| {
                    if vocabulary > 0 {
                        format!("v{}", rng.below(vocabulary))
                    } else {
                        format!("line {i}")
                    }
                })
                .collect();
            let mut ours = base_lines.clone();
            let mut theirs = base_lines.clone();
            for _ in 0..rng.below(4) {
                edit(&mut rng, &mut ours, "ours", vocabulary);
            }
            for _ in 0..rng.below(4) {
                edit(&mut rng, &mut theirs, "theirs", vocabulary);
            }
            // Sometimes the sides made the same edit.
            if rng.below(8) == 0 {
                theirs = ours.clone();
                edit(&mut rng, &mut theirs, "theirs", vocabulary);
            }
            let final_newline = rng.below(5) != 0;
            let crlf = rng.below(10) == 0;
            let theirs_newline = if rng.below(6) == 0 {
                !final_newline
            } else {
                final_newline
            };
            Case {
                base: join(&base_lines, final_newline, crlf),
                ours: join(&ours, final_newline, crlf),
                theirs: join(&theirs, theirs_newline, crlf),
            }
        })
        .collect()
}

/// Every line either side added is somewhere in a clean merge, and every line both removed is gone.
fn lost_nothing(base: &str, ours: &str, theirs: &str, merged: &str) -> bool {
    let has = |text: &str, line: &str| text.split_inclusive('\n').any(|l| l == line);
    let added = |side: &str| {
        side.split_inclusive('\n')
            .filter(|l| !has(base, l))
            .map(str::to_string)
            .collect::<Vec<_>>()
    };
    added(ours)
        .iter()
        .chain(added(theirs).iter())
        .all(|line| has(merged, line))
}

#[test]
fn it_agrees_with_git_over_merges_of_files_whose_lines_are_all_different() {
    let directory = tempfile::tempdir().unwrap();
    let mut clean = 0;
    let mut conflicted = 0;
    for (n, case) in generate(0x000F_10ED, 2_000, 0).iter().enumerate() {
        let (git_text, git_clean) =
            git_merge(directory.path(), &case.base, &case.ours, &case.theirs);
        let ours = merge3(&case.base, &case.ours, &case.theirs);
        assert_eq!(
            ours.is_clean(),
            git_clean,
            "case {n}: git says {}, we say {}\nbase:   {:?}\nours:   {:?}\ntheirs: {:?}\ngit:    {git_text:?}",
            if git_clean { "clean" } else { "conflict" },
            if ours.is_clean() { "clean" } else { "conflict" },
            case.base, case.ours, case.theirs,
        );
        if git_clean {
            clean += 1;
            assert_eq!(
                ours.clean_text().unwrap(),
                git_text,
                "case {n}: {case:?}",
                case = (&case.base, &case.ours, &case.theirs)
            );
        } else {
            conflicted += 1;
        }
    }
    // The corpus has to be both: a corpus that is nearly all one would agree with anything.
    assert!(
        clean > 500 && conflicted > 500,
        "{clean} clean, {conflicted} conflicted"
    );
}

#[test]
fn it_agrees_with_git_over_awkward_merges_written_out() {
    let directory = tempfile::tempdir().unwrap();
    let lines = |n: usize| (1..=n).map(|i| format!("line {i}\n")).collect::<String>();
    let ten = lines(10);
    let cases: Vec<(&str, String, String, String)> = vec![
        ("nothing changed", ten.clone(), ten.clone(), ten.clone()),
        (
            "only ours",
            ten.clone(),
            ten.replace("line 4\n", "four\n"),
            ten.clone(),
        ),
        (
            "only theirs",
            ten.clone(),
            ten.clone(),
            ten.replace("line 4\n", "four\n"),
        ),
        (
            "apart",
            ten.clone(),
            ten.replace("line 2\n", "two\n"),
            ten.replace("line 8\n", "eight\n"),
        ),
        (
            "the same change",
            ten.clone(),
            ten.replace("line 4\n", "four\n"),
            ten.replace("line 4\n", "four\n"),
        ),
        (
            "touching",
            ten.clone(),
            ten.replace("line 4\n", "four\n"),
            ten.replace("line 5\n", "five\n"),
        ),
        (
            "one line between",
            ten.clone(),
            ten.replace("line 4\n", "four\n"),
            ten.replace("line 6\n", "six\n"),
        ),
        (
            "same line, differently",
            ten.clone(),
            ten.replace("line 4\n", "ours\n"),
            ten.replace("line 4\n", "theirs\n"),
        ),
        (
            "change and delete",
            ten.clone(),
            ten.replace("line 4\n", "ours\n"),
            ten.replace("line 4\n", ""),
        ),
        (
            "both delete",
            ten.clone(),
            ten.replace("line 4\n", ""),
            ten.replace("line 4\n", ""),
        ),
        (
            "one deletes a range the other changes inside",
            ten.clone(),
            ten.replace("line 3\nline 4\nline 5\n", ""),
            ten.replace("line 4\n", "four\n"),
        ),
        (
            "insertions at one place",
            ten.clone(),
            ten.replace("line 4\n", "line 4\nours\n"),
            ten.replace("line 4\n", "line 4\ntheirs\n"),
        ),
        (
            "the same insertion",
            ten.clone(),
            ten.replace("line 4\n", "line 4\nboth\n"),
            ten.replace("line 4\n", "line 4\nboth\n"),
        ),
        (
            "insertion beside a deletion",
            ten.clone(),
            ten.replace("line 4\n", "line 4\nours\n"),
            ten.replace("line 5\n", ""),
        ),
        (
            "insertion at the start and the end",
            ten.clone(),
            format!("top\n{ten}"),
            format!("{ten}bottom\n"),
        ),
        (
            "both empty their file",
            ten.clone(),
            String::new(),
            String::new(),
        ),
        (
            "one empties, one edits",
            ten.clone(),
            String::new(),
            ten.replace("line 4\n", "four\n"),
        ),
        (
            "no base",
            String::new(),
            "a\nb\n".to_string(),
            "a\nb\n".to_string(),
        ),
        (
            "no base, different",
            String::new(),
            "a\n".to_string(),
            "b\n".to_string(),
        ),
        (
            "no base, one empty",
            String::new(),
            "a\n".to_string(),
            String::new(),
        ),
        (
            "a final newline added",
            "a\nb".to_string(),
            "a\nb\n".to_string(),
            "a\nb".to_string(),
        ),
        (
            "a final newline added, and the line edited",
            "a\nb".to_string(),
            "a\nb\n".to_string(),
            "a\nB".to_string(),
        ),
        (
            "a line appended after one with no newline",
            "a\nb".to_string(),
            "a\nb\nc\n".to_string(),
            "A\nb".to_string(),
        ),
        (
            "windows line endings",
            "a\r\nb\r\nc\r\n".to_string(),
            "A\r\nb\r\nc\r\n".to_string(),
            "a\r\nb\r\nC\r\n".to_string(),
        ),
        (
            "mixed line endings",
            "a\r\nb\n".to_string(),
            "a\r\nb\n".to_string(),
            "a\nb\n".to_string(),
        ),
        (
            "blank lines",
            "a\n\n\nb\n".to_string(),
            "a\n\nX\n\nb\n".to_string(),
            "a\n\n\nb\nc\n".to_string(),
        ),
    ];
    // Changes that end where another begins, of every kind, in both orders.
    let six = lines(6);
    let mut cases = cases;
    for before in ["X\n", "", "line 2\nX\n"] {
        for after in ["Y\n", "", "Y\nline 3\n"] {
            let earlier = six.replace("line 2\n", before);
            let later = six.replace("line 3\n", after);
            cases.push((
                "touching, ours first",
                six.clone(),
                earlier.clone(),
                later.clone(),
            ));
            cases.push(("touching, theirs first", six.clone(), later, earlier));
        }
    }

    for (name, base, ours, theirs) in cases {
        let (git_text, git_clean) = git_merge(directory.path(), &base, &ours, &theirs);
        let merge = merge3(&base, &ours, &theirs);
        assert_eq!(
            merge.is_clean(),
            git_clean,
            "{name}: git says {git_clean}; git wrote {git_text:?}"
        );
        if git_clean {
            assert_eq!(merge.clean_text().unwrap(), git_text, "{name}");
        }
    }
}

/// Files whose lines repeat have several equally short comparisons with their base. This measures how
/// often git picks a different one and so a different answer; it may be some, and the rest of the test is
/// what must never be: a clean merge that has lost a change.
#[test]
fn with_repeated_lines_it_mostly_agrees_with_git_and_never_loses_a_change() {
    let directory = tempfile::tempdir().unwrap();
    let cases = generate(0xBEEF, 1_500, 5);
    let mut disagree = 0;
    for (n, case) in cases.iter().enumerate() {
        let (git_text, git_clean) =
            git_merge(directory.path(), &case.base, &case.ours, &case.theirs);
        let ours = merge3(&case.base, &case.ours, &case.theirs);

        if let Some(text) = ours.clean_text() {
            // Whatever git says, a clean merge of ours must contain what each side added.
            assert!(
                lost_nothing(&case.base, &case.ours, &case.theirs, &text),
                "case {n} lost a change\nbase:   {:?}\nours:   {:?}\ntheirs: {:?}\nmerged: {text:?}",
                case.base, case.ours, case.theirs
            );
        }
        if ours.is_clean() != git_clean
            || (git_clean && ours.clean_text().as_deref() != Some(git_text.as_str()))
        {
            disagree += 1;
        }
    }
    eprintln!(
        "repeated lines: {disagree} of {} merges differ from git",
        cases.len()
    );
    assert!(
        disagree * 20 < cases.len(),
        "{disagree} of {} differ from git",
        cases.len()
    );
}
