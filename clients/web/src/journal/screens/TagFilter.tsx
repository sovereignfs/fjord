'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, FormField, Input } from '@sovereignfs/ui';
import styles from '../../auth/screens/screens.module.css';

/**
 * A journal's tags, each with how many entries carry it, and what narrows the timeline (ROADMAP 3b.3): tags it must have (an entry under
 * `project/fjord` has `project`, spec §8.1) and a range of days. Every tag is shown once, as it was first written: `Work` and `work` are one.
 */
export function TagFilter({
  tags,
  chosen,
  range,
  onChange,
}: {
  tags: { tag: string; count: number }[];
  chosen: string[];
  range: { from?: string; to?: string };
  onChange: (tags: string[], range: { from?: string; to?: string }) => void;
}) {
  const [from, setFrom] = useState(range.from ?? '');
  const [to, setTo] = useState(range.to ?? '');
  const day = (value: string) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined);
  const toggle = (tag: string) =>
    onChange(chosen.includes(tag) ? chosen.filter((t) => t !== tag) : [...chosen, tag], range);
  if (tags.length === 0 && chosen.length === 0 && !range.from && !range.to) return null;
  return (
    <details
      className={styles.itemMeta}
      open={chosen.length > 0 || Boolean(range.from || range.to)}
      data-testid="tag-filter"
    >
      <summary>Tags and dates{chosen.length > 0 ? `: ${chosen.join(', ')}` : ''}</summary>
      <p aria-label="Every tag">
        {tags.map(({ tag, count }) => (
          <Button
            key={tag}
            variant={chosen.includes(tag) ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => toggle(tag)}
            aria-pressed={chosen.includes(tag)}
          >
            #{tag} <Badge>{count}</Badge>
          </Button>
        ))}
      </p>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          onChange(chosen, { from: day(from), to: day(to) });
        }}
      >
        <FormField label="From" hint="YYYY-MM-DD">
          {(field) => (
            <Input {...field} name="from" value={from} onChange={(e) => setFrom(e.target.value)} />
          )}
        </FormField>
        <FormField label="To" hint="YYYY-MM-DD">
          {(field) => (
            <Input {...field} name="to" value={to} onChange={(e) => setTo(e.target.value)} />
          )}
        </FormField>
        <div className={styles.actions}>
          <Button type="submit" variant="secondary" size="sm">
            Show these days
          </Button>
          {chosen.length > 0 || range.from || range.to ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => onChange([], {})}>
              Show everything
            </Button>
          ) : null}
        </div>
      </form>
    </details>
  );
}

/** The same, for a timeline arranged on the server: a choice is the page's address (`?tag=…&from=…&to=…`), so it can be kept and shared. */
export function QueryTagFilter({
  base,
  tags,
  chosen,
  range,
}: {
  base: string;
  tags: { tag: string; count: number }[];
  chosen: string[];
  range: { from?: string; to?: string };
}) {
  const router = useRouter();
  return (
    <TagFilter
      tags={tags}
      chosen={chosen}
      range={range}
      onChange={(next, nextRange) => {
        const query = new URLSearchParams();
        for (const tag of next) query.append('tag', tag);
        if (nextRange.from) query.set('from', nextRange.from);
        if (nextRange.to) query.set('to', nextRange.to);
        const text = query.toString();
        router.push(text === '' ? base : `${base}?${text}`);
      }}
    />
  );
}
