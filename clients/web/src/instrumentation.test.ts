import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "../instrumentation";

/**
 * What a server does when it cannot start (instrumentation.ts): in production it exits with the reason, whatever
 * launched it, because the container image's own server logs a failed start-up hook and keeps serving, every request
 * an error. Sign-in is switched on with no secret, which is a setting `register` checks before it touches a database.
 */
describe("register", () => {
  let exit: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("FJORD_SKIP_DATABASE", "");
    vi.stubEnv("FJORD_AUTH_LOCAL", "1");
    vi.stubEnv("FJORD_AUTH_SECRET", "");
    vi.stubEnv("FJORD_AUTH_SECRET_FILE", "");
    vi.stubEnv("FJORD_URL", "http://localhost:3000");
    exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("exits, saying which setting is wrong, in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await register();
    expect(exit).toHaveBeenCalledWith(1);
    expect(JSON.stringify(error.mock.calls)).toContain("FJORD_AUTH_SECRET");
  });

  it("throws and does not exit when developing, where the framework shows the error", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await expect(register()).rejects.toThrow("FJORD_AUTH_SECRET");
    expect(exit).not.toHaveBeenCalled();
  });

  it("does nothing outside the Node runtime, or when told to skip the database", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await register();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("FJORD_SKIP_DATABASE", "1");
    await register();
    expect(exit).not.toHaveBeenCalled();
  });
});
