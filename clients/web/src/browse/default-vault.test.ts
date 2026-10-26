import { describe, expect, it } from "vitest";
import type { Discovery, RepositoryManifest, VaultListing } from "../format/types";
import { defaultVault } from "./default-vault";

const vault = (directory: string): VaultListing => ({ directory, name: directory, encrypted: false, fileNaming: "plain", suffix: ".age", manifestError: null, files: [] });
const found = (...directories: string[]): Discovery => ({ vaults: directories.map(vault), nested: [] });
const manifest = (...paths: (string | null)[]): RepositoryManifest => ({
  ok: true,
  version: 1,
  id: null,
  name: null,
  createdAt: null,
  vaultsState: "entries",
  vaults: paths.map((path) => ({ path, id: null })),
  raw: {},
});

describe("defaultVault", () => {
  it("is the first vault fjord.json lists, in its order and not the directories'", () => {
    expect(defaultVault(found("Private", "Public"), manifest("Public", "Private"), null)).toBe("Public");
    expect(defaultVault(found("Private", "Public"), manifest("Private", "Public"), null)).toBe("Private");
  });

  it("is the one the account chose, whatever fjord.json says", () => {
    expect(defaultVault(found("Private", "Public"), manifest("Public"), "Private")).toBe("Private");
  });

  it("skips a vault fjord.json lists that is not there: the filesystem is authoritative (spec §2.1)", () => {
    expect(defaultVault(found("Private", "Public"), manifest("Gone", "Public"), null)).toBe("Public");
    expect(defaultVault(found("B"), manifest("Gone", null), null)).toBe("B");
  });

  it("can be a vault fjord.json does not list", () => {
    expect(defaultVault(found("Listed", "Unlisted"), manifest("Listed"), "Unlisted")).toBe("Unlisted");
  });

  it("ignores a choice of a vault that has gone, and the first one stands in", () => {
    expect(defaultVault(found("Private", "Public"), manifest("Public"), "Deleted")).toBe("Public");
  });

  it("is the first vault found when there is no usable fjord.json", () => {
    expect(defaultVault(found("Private", "Public"), null, null)).toBe("Private");
    expect(defaultVault(found("Private", "Public"), { ok: false, error: "not json" }, null)).toBe("Private");
    expect(defaultVault(found("Private"), { ok: true, version: 1, id: null, name: null, createdAt: null, vaultsState: "absent", vaults: null, raw: {} }, null)).toBe("Private");
  });

  it("is nothing when there are no vaults", () => {
    expect(defaultVault(found(), manifest("Public"), "Public")).toBeUndefined();
    expect(defaultVault(found(), null, null)).toBeUndefined();
  });
});
