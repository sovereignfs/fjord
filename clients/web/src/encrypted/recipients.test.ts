import { describe, expect, it } from "vitest";
import { recipientsPath } from "./recipients";

const manifest = (recipients: unknown) => JSON.stringify({ name: "S", encryption: { tool: "age", recipients, suffix: ".age" } });

describe("where a vault's recipients file is", () => {
  it("is inside the vault, by the name its manifest gives", () => {
    expect(recipientsPath("Secret", manifest("recipients.txt"))).toBe("Secret/recipients.txt");
    expect(recipientsPath("Secret", manifest("keys/team.txt"))).toBe("Secret/keys/team.txt");
  });

  it.each([["a way up", "../other/recipients.txt"], ["an absolute path", "/etc/passwd"], ["an empty step", "a//b"], ["nothing", ""], ["not text", 5], ["a dot", "./x"]])("is nowhere for %s", (_name, value) => {
    expect(recipientsPath("Secret", manifest(value))).toBeUndefined();
  });

  it("is nowhere for a manifest that is missing, is not JSON, or does not say", () => {
    expect(recipientsPath("Secret", undefined)).toBeUndefined();
    expect(recipientsPath("Secret", "{nope")).toBeUndefined();
    expect(recipientsPath("Secret", "null")).toBeUndefined();
    expect(recipientsPath("Secret", JSON.stringify({ name: "S" }))).toBeUndefined();
  });
});
