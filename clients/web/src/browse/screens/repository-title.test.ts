import { describe, expect, it } from "vitest";
import { placeName, placeTitle } from "./repository-title";

describe("what a tab is called", () => {
  it("is the place and the repository, or the repository alone", () => {
    expect(placeTitle("acme/notes", "report")).toBe("report · acme/notes");
    expect(placeTitle("Scratch drive", undefined)).toBe("Scratch drive");
    expect(placeTitle("Scratch drive", "")).toBe("Scratch drive");
  });

  it("calls a file what a person does: a Doc without its extension, anything else whole", () => {
    expect(placeName("Public/Q4/report.fj.md")).toBe("report");
    expect(placeName("Public/idea.md")).toBe("idea");
    expect(placeName("Public/photo.png")).toBe("photo.png");
    expect(placeName("Public/Q4")).toBe("Q4");
  });
});
