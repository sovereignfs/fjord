/**
 * Runs `task` every `everyMs`, one run at a time: a run that is still going when the next is due makes that one wait, it does not
 * overlap it. A run that throws is logged by name and does not stop the loop. The timer does not keep the process alive.
 */
export function everyUnlessRunning(task: () => Promise<unknown>, everyMs: number, label: string): { stop: () => void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    task()
      .catch((error: unknown) => console.error(`[fjord] ${label}: unexpected ${error instanceof Error ? error.name : "failure"}`))
      .finally(() => {
        running = false;
      });
  }, everyMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
