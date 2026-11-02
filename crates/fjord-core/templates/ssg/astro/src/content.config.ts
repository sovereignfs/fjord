import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// Posts live in the Fjord vault `content/`, outside `src/`. The pattern takes Markdown only, so the
// vault's own `fjord.vault.json` is never read as an entry. Fjord's `id` key is not declared here, and
// Astro's schema drops it from the parsed data without touching the file.
const posts = defineCollection({
  loader: glob({ base: "./content/posts", pattern: "**/*.md" }),
  schema: z.object({
    title: z.string().optional(),
    date: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
    description: z.string().optional(),
  }),
});

export const collections = { posts };
