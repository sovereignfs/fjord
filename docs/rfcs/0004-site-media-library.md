# RFC 0004 — A media library for sites

| | |
| --- | --- |
| **Status** | Implemented, 2026-11-08 ([tasks](../epics/web-3.md#3j--media-library)). P18 found that a Jekyll site whose vault is `_posts` cannot hold images in its vault (Jekyll skips directories that begin with an underscore); the owner chose `assets/images/` for that layout |
| **Date** | November 2026 |
| **Author** | Claude Code, for review |
| **Scope** | [`docs/specs/Fjord.spec.md`](../specs/Fjord.spec.md) §1.1 (one clarifying sentence, no format change); `fjord-core` (`site`), `fjord-wasm`; `packages/fjord-editor`; Fjord Web ([`clients/web/DESIGN.md`](../../clients/web/DESIGN.md), a new section) |
| **Tasks** | [`docs/epics/web-3.md`](../epics/web-3.md#3j--media-library): P18–P20, then 3j.1–3j.5 |
| **Supersedes** | Nothing. It goes before collaborative editing (Fjord Web's phase 4) in the priorities |

## Summary

An `ssg` repository gets a **media library**: a screen of the site's images, where a person browses them, uploads new ones and
deletes ones no longer wanted, and the same library opened from the post editor to put an image into a post. Images are files in the
site's vault, in one folder chosen by the engine, committed like any other file; the post refers to them in the form its engine reads.
Images only. Nothing about the format changes: the library is a client's view of files the format already allows.

## Motivation

A post on a site almost always has pictures. Today the web client can write a post but not give it one: the document editor takes
an image by URL or by a path to a file already in the repository (DESIGN.md §10, "no uploads in phase 1"), and nothing in Fjord puts
a file there. The person has to commit the image somewhere else, know which folder the engine serves, and type a path that resolves
from the post. For a site that is the most common thing they will do after writing.

## Fit with the format's scope

Spec §1.1 says Fjord stores documents and *the attachments that belong to them*, pasted images among them, and that it is not a
photo or video store: "Media libraries are explicitly out of scope". That sentence is about the **format**: there is no media layout,
no media metadata, no large-file storage, and there will not be. This RFC keeps all of that. It is a client screen that lists, adds and
removes ordinary image files in a plaintext vault, which the format already permits, and every image it handles is there for posts.

What changes in the spec is one sentence, added to §1.1 so the two are not read as in conflict:

> A client MAY present the images in a repository as a library and let a person add them to Docs; they remain ordinary files under
> the rules of this document.

What stays out, as before: video and audio, albums, image metadata in any file Fjord defines (§12, "Metadata for vault files that are
not Markdown", stays reserved), Git LFS, and any limit the format would enforce.

## Design

### Where images go

**One folder per engine, inside the site's vault.** Fjord chooses it; the person does not. Inside the vault, because the site's view
writes only inside its vault (3g.1), and because the vault is what the engine already reads. The folders below are the proposal and
are confirmed by building in P18; if an engine cannot serve images from inside its vault, P18 stops and the owner decides (see *Open*).

| Engine | Vault | Images folder | A post refers to an image as | Built, P18 |
| --- | --- | --- | --- | --- |
| Astro, scaffold | `content/` | `content/images/` | a path relative to the post (`../images/x.webp`) | ✅ Astro 5.18.2: optimised to `/_astro/x.<hash>.webp`, no warning |
| Astro, adopted | `src/content/` | `src/content/images/` | the same | ✅ the same output, no warning (the site's `glob()` base is `posts/`, so the folder is no collection) |
| Jekyll, scaffold | `content/` (`collections_dir`) | `content/images/` | a site-absolute path (`/content/images/x.png`) | ✅ Jekyll copies it to `_site/content/images/x.png`. With a `baseurl` the reference would need it; the scaffold sets none |
| Jekyll, adopted | `_posts/` | **none works** | | ❌ Jekyll skips every directory that starts with an underscore, so `_posts/images/x.png` is not copied to the site |

The spike's one stop: a Jekyll site whose vault *is* `_posts` cannot hold its images in its vault, and the RFC's rule (the site's view writes only inside its vault) leaves that layout without a library until the owner picks between the options in *Open*.

Images that a site already has, anywhere in its vault, are shown in the library and can be inserted; they are never moved. Images
outside the vault (an Astro site's `public/` or `src/assets/`, a Jekyll site's `assets/`) are the engine's files and are not shown.

The rules (the folder for an engine and vault, a safe file name for an upload, the reference from a post to an image, and finding which
posts refer to an image) are **`fjord-core`'s `site` module**, beside `post_path`, so that every client writes the same paths
(root `CLAUDE.md`, *Adding a component* 6). The CLI gains nothing in this RFC: a person with a terminal copies a file.

### File names

An upload's name is made from its file name: lowercased, NFC, spaces and anything outside `[a-z0-9._-]` to `-`, the extension from
its real type (below), and `-2`, `-3`… on a clash, compared case-blind. A file whose bytes are already in the folder is not uploaded
twice: the library says so and offers the one that is there.

### The library

- **A screen of the site**, beside its posts: the images as a grid of thumbnails (the listing's rows-or-tiles toggle), newest first by
  the commit that added them where that is cheap, else by name, with name, size and pixel size, and a filter by name.
- **Upload** by a button or by dropping files on the screen; several at once, one commit for the batch (`Add 3 images`).
- **Delete** asks first and lists every post that refers to the image (`site` finds them); a deletion is one commit and is in the
  repository's *What was deleted*, like any other file.
- **Thumbnails** are the image itself, served by a route of the repository's files, scaled by the browser. No thumbnail files are
  written anywhere.

### Upload, in the browser and on the server

- **Types:** PNG, JPEG, WebP, GIF and AVIF, told apart by their first bytes, not their name or the browser's word for them; the
  extension follows the bytes. **SVG is not accepted**: it is a document that can carry script. One that is in the vault already is
  shown, through an `<img>` only, and served with `Content-Disposition: attachment` and a sandboxing CSP.
- **Resized before it leaves the browser:** an image whose longer side exceeds 2560 px is scaled to it and re-encoded (WebP, or JPEG
  where WebP is not available, quality 0.85). An animated GIF, and anything already within the bound, is uploaded as it is.
  Re-encoding drops EXIF, which is the point: a photo's GPS position should not be published by accident. The person is told when an
  image was resized, and can upload the original instead, which keeps its metadata and says so.
- **A cap of 10 MB per image after resizing**, well under the 25 MB the spec warns at (§1.1, `W604`), checked in the browser and again
  on the server, with the type. The server never decodes an image; it checks the first bytes and the size, and commits.
- **Committed at once**, on the branch the person is on, as the person (like a new post), not through the working copy: the image has
  to exist for the post that refers to it to build, and an image has nothing to merge.

### Into a post

- **The editors get an image source** (`packages/fjord-editor`): an interface the host supplies, with *choose* (opens the host's
  library and returns a reference and alt text), *upload* (bytes in, a reference out) and *resolve* (a reference in, a URL the
  editor can display). The editors know nothing of sites or engines, so the same interface serves a drive's Docs later.
- **The note editor** (Markdown) gets an *Insert image* command that inserts `![alt](reference)` at the cursor. **The document
  editor** replaces MDXEditor's URL dialog with the library, through `imagePlugin`'s upload and dialog hooks, and shows images by
  *resolve*, so a relative reference displays.
- **Alt text is required.** Choosing an image asks for it, and *Insert* stays disabled until it is given; "decorative" is a box that
  inserts an empty alt on purpose. It is asked at insertion, not stored with the image: the format has no place for an image's
  metadata (§12), and the same picture can need different words in two posts.
- **Paste and drop.** An image pasted or dropped into either editor goes through the same upload (type, resize, cap, name) into the
  library, then asks for alt text and inserts the reference. Cancelling the alt text leaves the image in the library and inserts nothing.

### Where it is offered

Only an `ssg` repository's vault, which is always plaintext (spec §3.1). A drive, a journal and a repository kept on the server
(3i.1, which offers no sites) get nothing yet; the editor interface and the `site` rules are shaped so a drive can follow without
being redesigned.

## Alternatives rejected

| Alternative | Why not |
| --- | --- |
| The engine's own asset folder (`public/`, `src/assets/`, `assets/`) | Outside the vault, so the site's view would write beyond its vault (3g.1), and the folder differs from site to site and would need a setting in `fjord.json`. Kept as the fallback if P18 finds an engine that cannot serve images from its vault |
| A folder per post (`posts/my-post/cover.webp`) | Neither engine's post layout in Fjord is a folder per post, and an image used by two posts would have no one home |
| Git LFS | A host feature, not git's; a repository using it cannot be read with plain `git` and `age` (spec §1), and hosts charge for it |
| Storing alt text with the image (a sidecar or a manifest) | Metadata for files that are not Markdown is reserved (spec §12), and alt text belongs to the use, not the picture |
| Resizing on the server | The server would decode untrusted images, the most attacked code there is, and receive the full-size file anyway |
| Accepting SVG | Script in an image the instance serves; the gain is small for a blog |

## Security considerations

- Uploaded bytes are untrusted: their type is read from their first bytes, the server never decodes or transforms them, and every
  image route answers with the type the bytes are, `X-Content-Type-Options: nosniff`, and the app's CSP (`img-src 'self' data: blob:`
  already allows it).
- SVG is never accepted, and one already in a vault is never served as a document.
- The browser's re-encoding strips EXIF, including location, by default; uploading the original is a choice the person makes, told
  what it keeps.
- Who may upload and delete is who may write the repository (the existing access rules); the routes are checked like the other file
  routes (`access.test.ts`).
- Only a plaintext vault is offered, so no image is ever written into an encrypted one (invariant 1 cannot be reached from here).

## Open

- **Decided 2026-11-08: option (2).** **A Jekyll site whose vault is `_posts`** (found by P18). Options: (1) not offered a library for this layout, its images stay the engine's files; (2) the library for it uses the site's `assets/images/` outside the vault, a place Jekyll serves and a convention many Jekyll sites already follow, the one exception to "inside the vault", and `fjord.json` records nothing; (3) the same at `images/`, the root. Decided by the owner before P19.
- Jekyll with a `baseurl`: a reference written site-absolute does not carry it. The scaffold sets none; a site that does is the site owner's to adjust, as Jekyll's own documentation says.

## Not here

The CLI; a drive's or a journal's images; cropping, focal points and captions; a cover-image field in the post form; an image used in a
post's frontmatter; renaming an image (with its references); usage of the repository's size; video, audio and any other media.
