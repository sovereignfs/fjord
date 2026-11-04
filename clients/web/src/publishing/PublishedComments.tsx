import type { CommentMode } from "./publications";

/**
 * Where a published page's comments will be (the owner deferred them): the page keeps who may comment (`off`, for `anyone`, or for `users` with an account here), which the owner sets when
 * publishing, and puts this component after the document. It draws nothing yet. A page's comments are the document's (`src/comments/`), by the same text-quote anchors, written
 * by someone who has no share: the principal for `anyone` is a guest of the page (a name they give, as a link's guest has) and for `users` an account, and the rates for it are the page's, as `limits/` asks of a route that writes without a
 * session. None of that is built; when it is, it is built here and in the comments' own store, and a page published now needs no change.
 */
export function PublishedComments({ mode }: { mode: CommentMode }) {
  void mode;
  return null;
}
