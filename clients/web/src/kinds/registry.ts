import type { RepositoryManifest } from "../format/types";
import { driveKind } from "./drive";
import { journalKind } from "./journal";
import { ssgKind } from "./ssg";
import type { KindModule } from "./types";

/**
 * Which module presents a repository (RFC 0001, DESIGN.md §8 "Repository kinds"): the one registered for its kind, and the drive's
 * for any other. Spec §3.1: a kind a client does not know is presented as a drive, so a repository made by a newer client, or of a
 * kind this build has no module for yet, still opens, on its files. The kind itself is the format module's answer
 * (`describeRepositoryManifest`), never read from `fjord.json` here.
 */
const modules = new Map<string, KindModule>([
  [driveKind.id, driveKind],
  [journalKind.id, journalKind],
  [ssgKind.id, ssgKind],
]);

/** Add a kind's module. The kinds of this build register themselves where they are defined; a test may register a stand-in. */
export function registerKind(module: KindModule): void {
  modules.set(module.id, module);
}

/** Take a module away again (for tests). The drive cannot be: it is what every other kind falls back to. */
export function unregisterKind(id: string): void {
  if (id !== driveKind.id) modules.delete(id);
}

/**
 * The module for a repository with this `fjord.json`: none, one that cannot be read, or one of a kind that is not registered all
 * give the drive.
 */
export function kindFor(manifest: RepositoryManifest | null): KindModule {
  if (!manifest?.ok) return driveKind;
  if (manifest.kind !== "drive") return modules.get(manifest.kind) ?? driveKind;
  // A kind the format module does not define (it says "drive") may still be one a module of this client presents: a kind of a
  // newer revision, or a test's stand-in. A defined kind it presents as a drive (an `ssg` with an engine it does not know) is a drive.
  const declared = manifest.declaredKind;
  if (declared !== null && !DEFINED.has(declared)) return modules.get(declared) ?? driveKind;
  return driveKind;
}

const DEFINED = new Set(["drive", "journal", "ssg"]);

/** Every registered kind, the drive first: what setting a repository up offers. */
export function registeredKinds(): KindModule[] {
  return [driveKind, ...[...modules.values()].filter((module) => module.id !== driveKind.id)];
}
