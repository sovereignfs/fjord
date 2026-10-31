import { findUser } from "../auth/users";
import { connectionService } from "../connections/server";
import { getAuthDatabase, getDatabase } from "../db/boot";
import { WorkingCopyService } from "../working/service";
import { guestIdentity } from "../working/version";
import { idleVersionMs, workerEnabled } from "./config";
import { createIdleVersions } from "./idle";
import { everyUnlessRunning } from "./loop";

/** How often the drafts are looked at: the quiet period is in minutes, so a minute is as late as a version can be. */
const PASS_EVERY_MS = 60 * 1000;

/**
 * Starts the worker in this process (ROADMAP 1b.13): for now idle versions, later the GitHub App's webhook jobs (1a.6). The
 * single-container setup is this process; a deployment with several web processes sets `FJORD_WORKER=off` on all but one. Does
 * nothing, and says so, when the instance has switched it off or has no key to read repository tokens with.
 */
export function startWorker(env: Record<string, string | undefined> = process.env): { stop: () => void } | undefined {
  if (!workerEnabled(env)) {
    console.info("[fjord] worker: off (FJORD_WORKER=off)");
    return undefined;
  }
  const idleMs = idleVersionMs(env);
  if (idleMs === undefined) {
    console.info("[fjord] worker: idle versions are off (FJORD_IDLE_VERSION_MINUTES=0)");
    return undefined;
  }
  console.info(`[fjord] worker: a draft is saved as a version after ${idleMs / 60000} minutes without an edit`);

  const idle = createIdleVersions({
    drafts: {
      idle: async (before, limit) => new WorkingCopyService(await getDatabase()).idle(before, limit),
      get: async (id, path) => new WorkingCopyService(await getDatabase()).get(id, path),
      discardUnchanged: async (id, path, lastEdit) => new WorkingCopyService(await getDatabase()).discardUnchanged(id, path, lastEdit),
    },
    target: async (connectionId) => {
      const used = await (await connectionService()).providerForShare(connectionId);
      return used && { provider: used.provider, ref: used.ref, branch: used.branch, ownerId: used.ownerId };
    },
    identityOf: async (editor) => (editor.type === "account" ? findUser(await getAuthDatabase(), editor.id) : guestIdentity(editor)),
    now: Date.now,
    idleMs,
  });

  return everyUnlessRunning(
    async () => {
      const report = await idle.pass();
      if (report.made > 0) console.info(`[fjord] worker: ${report.made} idle ${report.made === 1 ? "version" : "versions"} saved`);
    },
    PASS_EVERY_MS,
    "worker",
  );
}
