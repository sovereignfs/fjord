import { describe, expect, it } from "vitest";
import { DEFAULT_LOCAL_LIMITS, formatBytes, limitMessage, localLimits } from "./limits";

describe("the limits of repositories kept on this server", () => {
  it("are 3 repositories, 50 MiB and 2000 files unless the instance says otherwise", () => {
    expect(localLimits({})).toEqual({ repositories: 3, bytes: 50 * 1024 * 1024, files: 2000 });
    expect(DEFAULT_LOCAL_LIMITS).toEqual(localLimits({}));
  });

  it("are read from FJORD_LOCAL_MAX_REPOSITORIES, FJORD_LOCAL_MAX_MIB and FJORD_LOCAL_MAX_FILES", () => {
    expect(localLimits({ FJORD_LOCAL_MAX_REPOSITORIES: "10", FJORD_LOCAL_MAX_MIB: "200", FJORD_LOCAL_MAX_FILES: "9000" })).toEqual({ repositories: 10, bytes: 200 * 1024 * 1024, files: 9000 });
  });

  it("can turn the feature off with 0 repositories", () => {
    expect(localLimits({ FJORD_LOCAL_MAX_REPOSITORIES: "0" }).repositories).toBe(0);
  });

  it("never lose a limit to a typo: what is not a whole number in range is the default", () => {
    for (const value of ["", " ", "many", "-1", "1.5", "1e3", "0x10", "99999999999"]) {
      expect(localLimits({ FJORD_LOCAL_MAX_REPOSITORIES: value, FJORD_LOCAL_MAX_MIB: value, FJORD_LOCAL_MAX_FILES: value }), value).toEqual(DEFAULT_LOCAL_LIMITS);
    }
    // 0 bytes or 0 files would be a limit nobody can use: that is not a setting either.
    expect(localLimits({ FJORD_LOCAL_MAX_MIB: "0", FJORD_LOCAL_MAX_FILES: "0" })).toEqual(DEFAULT_LOCAL_LIMITS);
  });

  it("are said in words that tell a person what to do", () => {
    const limits = DEFAULT_LOCAL_LIMITS;
    expect(limitMessage("repositories", limits)).toContain("3 repositories");
    expect(limitMessage("files", limits)).toContain("2000 files");
    expect(limitMessage("bytes", limits)).toContain("50 MiB");
    for (const kind of ["repositories", "files", "bytes"] as const) expect(limitMessage(kind, limits)).toMatch(/connect one to a git repository/i);
    expect(limitMessage("repositories", { ...limits, repositories: 0 })).toContain("does not keep repositories on the server");
  });

  it("formats sizes as a person reads them", () => {
    expect(formatBytes(12)).toBe("12 B");
    expect(formatBytes(2048)).toBe("2 KiB");
    expect(formatBytes(3.2 * 1024 * 1024)).toBe("3.2 MiB");
    expect(formatBytes(50 * 1024 * 1024)).toBe("50 MiB");
  });
});
