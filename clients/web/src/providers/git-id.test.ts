import { describe, expect, it } from "vitest";
import { gitBlobId } from "./git-id";

describe("gitBlobId", () => {
  // `printf '' | git hash-object --stdin` and `printf 'hello\n' | git hash-object --stdin`
  it("agrees with git for the empty file and a small one", () => {
    expect(gitBlobId(new Uint8Array())).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(gitBlobId(new TextEncoder().encode("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("depends on every byte", () => {
    expect(gitBlobId(new Uint8Array([0, 255]))).not.toBe(gitBlobId(new Uint8Array([0, 254])));
  });
});
