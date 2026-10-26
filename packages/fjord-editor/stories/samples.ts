// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { CommentsAdapter, ThreadMark } from "../src/index.js";

export const SAMPLE_DOCUMENT = `# Quarterly plan

The **quick** brown fox jumps over the lazy dog. This paragraph is here to be selected, commented on and edited.

- [x] Draft the plan
- [ ] Share it with the team

| Region | Target |
| ------ | ------ |
| North  | 120    |
| South  | 95     |
`;

export const SAMPLE_NOTE = `Buy milk

- eggs
- oat milk
- coffee
`;

/** A comments adapter of the kind the app writes, in memory: for showing how the editor behaves with one. */
export function demoComments(initial: ThreadMark[] = []): CommentsAdapter & { added: number } {
  let threads = initial;
  const listeners = new Set<() => void>();
  const adapter = {
    added: 0,
    threads: () => threads,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    create(anchor: ThreadMark["anchor"]) {
      adapter.added += 1;
      threads = [...threads, { id: `demo-${adapter.added}`, anchor, resolved: false, outdated: false }];
      for (const listener of listeners) listener();
    },
    open() {},
  };
  return adapter;
}
