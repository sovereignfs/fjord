"use client";

import { useEffect } from "react";

/**
 * What a page's tab is called, from what the page found out as it was drawn. A page's `metadata` is decided before that (and would have to read the repository twice),
 * so it says what kind of page this is; this says which. Drawn once in a page.
 */
export function PageTitle({ title }: { title: string }) {
  useEffect(() => {
    document.title = `${title} · Fjord`;
  }, [title]);
  return null;
}
