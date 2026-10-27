/**
 * Keeping a draft as someone types (ROADMAP 1b.8), in the browser: what to send and when, never more than one request at
 * a time, and never losing the latest text. It knows nothing of the page or of HTTP (`send` is given), so it is tested
 * with fake timers.
 *
 *  - **Debounced.** The text is sent `delay` after the last change, and at the latest `maxWait` after the first change that
 *    has not been sent, so a long burst of typing is still kept.
 *  - **One in flight.** A change made while a save is on its way is sent after it, as the latest text, so the server never
 *    sees them out of order and an older text never replaces a newer one.
 *  - **Sent only if it differs** from what the server holds (the draft, or the note when there is none): typing a letter
 *    and deleting it again starts no draft.
 *  - **A failure is retried** with growing waits; nothing is dropped. A refusal that is about the text (it cannot be kept,
 *    it is too large) waits for the next change, which may fix it; a refusal that is about the draft (another version, no
 *    longer allowed) stops the saving, and says so.
 */
export type Attempt =
  | { kind: "kept" }
  /** The server said no. `stop` is for a refusal that no change to the text can fix. */
  | { kind: "refused"; stop: boolean; message: string }
  /** The request did not get an answer, or the server could not keep it just now: try again. */
  | { kind: "failed" };

export type SaverStatus =
  /** Nothing has been changed (or it is all as the server has it). */
  | { state: "idle" }
  | { state: "pending" }
  | { state: "saving" }
  | { state: "kept" }
  | { state: "retrying"; attempt: number }
  | { state: "refused"; message: string }
  | { state: "stopped"; message: string };

export interface Timers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
}

export interface SaverOptions {
  /** What the server holds now: the draft's text, or the note's text when there is no draft. */
  initial: string;
  send: (content: string) => Promise<Attempt>;
  delay?: number;
  maxWait?: number;
  /** How long to wait before each retry, the last one repeating. */
  backoff?: number[];
  timers?: Timers;
}

const BROWSER_TIMERS: Timers = { setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms), clearTimeout: (handle) => globalThis.clearTimeout(handle as never), now: () => Date.now() };

export class DraftSaver {
  private readonly send: SaverOptions["send"];
  private readonly delay: number;
  private readonly maxWait: number;
  private readonly backoff: number[];
  private readonly timers: Timers;
  private kept: string;
  private latest: string;
  private timer: unknown;
  private waitingSince: number | undefined;
  private running: Promise<void> | undefined;
  private failures = 0;
  private everKept = false;
  private halted = false;
  private current: SaverStatus = { state: "idle" };
  private readonly listeners = new Set<(status: SaverStatus) => void>();

  constructor(options: SaverOptions) {
    this.send = options.send;
    this.delay = options.delay ?? 1000;
    this.maxWait = options.maxWait ?? 5000;
    this.backoff = options.backoff?.length ? options.backoff : [2000, 5000, 15000, 30000];
    this.timers = options.timers ?? BROWSER_TIMERS;
    this.kept = options.initial;
    this.latest = options.initial;
  }

  get status(): SaverStatus {
    return this.current;
  }

  /** The text as it is on screen now. */
  get text(): string {
    return this.latest;
  }

  /** Whether the text on screen is not (yet) what the server holds. */
  get unsaved(): boolean {
    return this.latest !== this.kept;
  }

  subscribe(listener: (status: SaverStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The text is now `content`. */
  change(content: string): void {
    this.latest = content;
    if (this.halted) return;
    if (!this.unsaved && this.running === undefined) {
      this.cancel();
      this.waitingSince = undefined;
      this.set(this.everKept ? { state: "kept" } : { state: "idle" });
      return;
    }
    if (this.running !== undefined) return; // sent after the one on its way, as the latest text
    if (this.failures === 0) this.set({ state: "pending" });
    // A retry is on its timer already: more typing must not push it back, or typing could put it off for ever.
    if (this.failures === 0 || this.timer === undefined) this.schedule();
  }

  /** Send what is waiting now, and resolve when nothing is. Safe to call at any time, such as when the page is being hidden. */
  async flush(): Promise<void> {
    if (this.halted) return;
    this.cancel();
    if (this.running === undefined && this.unsaved) this.start();
    await this.running;
  }

  /** Stop for good (the page is going away). Nothing is sent. */
  dispose(): void {
    this.cancel();
    this.halted = true;
    this.listeners.clear();
  }

  private schedule(): void {
    this.cancel();
    const now = this.timers.now();
    this.waitingSince ??= now;
    const wait = this.failures > 0 ? (this.backoff[Math.min(this.failures - 1, this.backoff.length - 1)] as number) : Math.max(0, Math.min(this.delay, this.maxWait - (now - this.waitingSince)));
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.start();
    }, wait);
  }

  private cancel(): void {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private start(): void {
    if (this.running !== undefined || this.halted || !this.unsaved) return;
    this.running = this.run().finally(() => {
      this.running = undefined;
    });
  }

  private async run(): Promise<void> {
    const snapshot = this.latest;
    this.waitingSince = undefined;
    this.set({ state: "saving" });
    let attempt: Attempt;
    try {
      attempt = await this.send(snapshot);
    } catch {
      attempt = { kind: "failed" };
    }
    if (this.halted) return;

    if (attempt.kind === "kept") {
      this.kept = snapshot;
      this.everKept = true;
      this.failures = 0;
      if (this.unsaved) {
        this.set({ state: "pending" });
        this.schedule();
      } else {
        this.set({ state: "kept" });
      }
    } else if (attempt.kind === "refused") {
      this.failures = 0;
      if (attempt.stop) {
        this.halted = true;
        this.set({ state: "stopped", message: attempt.message });
      } else {
        this.set({ state: "refused", message: attempt.message });
        // What was refused is not what is on screen any more: that may be fine.
        if (this.latest !== snapshot) this.schedule();
      }
    } else {
      this.failures += 1;
      this.set({ state: "retrying", attempt: this.failures });
      this.schedule();
    }
  }

  private set(status: SaverStatus): void {
    this.current = status;
    for (const listener of this.listeners) listener(status);
  }
}
