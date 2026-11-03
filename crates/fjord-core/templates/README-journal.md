# Journal

A Fjord repository of the **journal** kind (`"kind": "journal"` in
`fjord.json`): a timeline of dated entries, kept as plain files in a Git
repository you control. Nothing here is specific to the Fjord app.

## Layout

```
.
├── README.md          this file
├── fjord.json         repository manifest; "kind": "journal"
├── .gitattributes
├── .gitignore
└── journal/           the journal's one vault
    └── fjord.vault.json
```

Each entry is a Markdown file with a frontmatter block. Its `date` says when
the entry is about, with the writer's local offset, so an entry written after
midnight belongs to the day it was written on:

```markdown
---
id: 01jagc4k7pt8y3wqnmzv5xrb9c
title: Morning run
date: 2026-11-02T08:14:00+05:30
tags: [health, running]
---

Five kilometres before the rain.
```

Fjord files a new entry at `journal/YYYY-MM-DD/hh-mm.md`: a folder for each day, and a file named by the time it was made.
That is a convention, not a rule: move an entry anywhere in `journal/` and its
`date` still places it. Tags are compared without regard to case, and `/`
nests them: `project/fjord` is under `project`.

If `journal/` is encrypted the day folders are still there, and **folder names are never encrypted**, so anyone who can read this repository can see
which days have entries. The files in them are named by their ids, so the time and everything else about an entry stays inside it. Every file is encrypted
with [age](https://age-encryption.org) to the keys in `journal/recipients.txt`,
and each holds a tar archive of one file, so `age -d -i key.txt FILE.age | tar -x`
recovers an entry under its real name.

The format is specified in full at
<https://github.com/sovereignfs/fjord/blob/main/docs/specs/Fjord.spec.md>.
