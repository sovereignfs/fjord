import { describe, expect, it } from "vitest";
import { MAX_SIDE, mayBeAnimated, scaledSize } from "./prepare-image";

/** Getting a picture ready to upload (RFC 0004): the scale is arithmetic, and what must never be re-encoded is told by its bytes. */
const text = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe("scaling a picture to the bound", () => {
  it("leaves one within the bound alone", () => {
    expect(scaledSize(800, 600)).toBeNull();
    expect(scaledSize(MAX_SIDE, MAX_SIDE)).toBeNull();
  });
  it("makes the longer side the bound and keeps the proportion", () => {
    expect(scaledSize(6000, 4000)).toEqual({ width: 2560, height: 1707 });
    expect(scaledSize(4000, 6000)).toEqual({ width: 1707, height: 2560 });
    expect(scaledSize(10000, 1)).toEqual({ width: 2560, height: 1 });
  });
  it("is not asked about a picture with no size", () => {
    expect(scaledSize(0, 100)).toBeNull();
    expect(scaledSize(Number.NaN, 100)).toBeNull();
  });
});

describe("what must keep its frames", () => {
  it("is every GIF, an APNG and an animated WebP", () => {
    expect(mayBeAnimated(text("GIF89a.."))).toBe(true);
    expect(mayBeAnimated(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, ...text("\r\n\x1a\n....acTL....IDAT")]))).toBe(true);
    expect(mayBeAnimated(text("RIFF....WEBPVP8X....ANIM...."))).toBe(true);
  });
  it("is not a still PNG, a JPEG or a still WebP", () => {
    expect(mayBeAnimated(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, ...text("\r\n\x1a\n....IHDR....IDAT")]))).toBe(false);
    expect(mayBeAnimated(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe(false);
    expect(mayBeAnimated(text("RIFF....WEBPVP8 ...."))).toBe(false);
  });
});
