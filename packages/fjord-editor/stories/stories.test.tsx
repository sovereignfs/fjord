// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { cleanup, render } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it } from "vitest";
import * as documentStories from "./DocumentEditor.stories.js";
import * as noteStories from "./NoteEditor.stories.js";

/** Every story renders, so the examples cannot rot while the interface moves. */
afterEach(cleanup);

describe.each([
  ["DocumentEditor", documentStories],
  ["NoteEditor", noteStories],
])("%s stories", (_name, stories) => {
  const all = Object.entries(stories) as [string, ComponentType][];

  it("has some", () => {
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  for (const [name, Story] of all) {
    it(`renders ${name}`, () => {
      const view = render(<Story />);
      expect(view.getByRole("textbox")).toBeTruthy();
    });
  }
});
