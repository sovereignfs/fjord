import { expect, signUp, test } from "./helpers";

/**
 * The age identity in the browser (ROADMAP 2a.1, 2a.2), in a real browser under the real Content-Security-Policy: that the module loads and runs
 * under `'wasm-unsafe-eval'`, that an identity is made, kept sealed, locked and opened again by its passphrase, and that neither the secret nor the
 * passphrase is sent anywhere or left in any storage a page can read.
 */
const PASSPHRASE = "a passphrase of some length";

test("an identity is made in the browser, kept sealed, locked on a reload and opened by its passphrase, and nothing secret leaves the page", async ({ page, context }) => {
  // The policy's violations, as the browser reports them.
  await page.addInitScript(() => {
    (window as unknown as { __violations: string[] }).__violations = [];
    document.addEventListener("securitypolicyviolation", (event) => (window as unknown as { __violations: string[] }).__violations.push(`${event.violatedDirective} ${event.blockedURI}`));
  });
  const sent: string[] = [];
  page.on("request", (request) => sent.push(`${request.method()} ${request.url()} ${request.postData() ?? ""} ${JSON.stringify(request.headers())}`));

  await signUp(page);
  await page.goto("/account/keys");
  await expect(page.getByRole("heading", { name: "Encryption identity" }).first()).toBeVisible();

  // Made, under the policy: the module loads from this origin and compiles.
  await page.getByLabel("Passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Make an identity" }).click();
  const recipient = page.getByTestId("recipient");
  await expect(recipient).toHaveText(/^age1[a-z0-9]{58}$/, { timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Lock" })).toBeVisible();
  const key = (await recipient.textContent())!;

  // A reload is a new page: the identity is locked, its public key shown, and the passphrase opens it.
  await page.reload();
  await expect(page.getByTestId("recipient")).toHaveText(key);
  await expect(page.getByRole("button", { name: "Unlock" })).toBeVisible();
  await page.getByLabel("Passphrase").fill("not the passphrase");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("That passphrase does not open the identity.")).toBeVisible({ timeout: 60_000 });
  await page.getByLabel("Passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("button", { name: "Lock" })).toBeVisible({ timeout: 60_000 });

  // The secret, read from the sealed file only by the page, is what the public key is of; take it to see where it went.
  const secret = await page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const open = indexedDB.open("fjord-keys", 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const record: { sealed: Uint8Array; recipient: string } = await new Promise((resolve, reject) => {
      const get = db.transaction("identity").objectStore("identity").get("main");
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    db.close();
    // What is kept is bytes and a public key: the sealed file begins with age's header and holds no text of the key.
    const text = new TextDecoder("latin1").decode(record.sealed);
    return { keys: Object.keys(record).sort(), header: text.startsWith("age-encryption.org/v1"), mentionsKey: text.includes("AGE-SECRET-KEY"), mentionsPassphrase: text.includes("a passphrase of some") };
  });
  expect(secret).toEqual({ keys: ["createdAt", "recipient", "sealed"], header: true, mentionsKey: false, mentionsPassphrase: false });

  // Nothing sent holds the passphrase or a secret key, and the page keeps neither in cookies or web storage.
  for (const request of sent) {
    expect(request, request.slice(0, 120)).not.toContain(PASSPHRASE);
    expect(request).not.toContain("AGE-SECRET-KEY");
    expect(request).not.toContain(encodeURIComponent(PASSPHRASE));
  }
  expect(JSON.stringify(await context.cookies())).not.toContain(PASSPHRASE);
  const storage = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
  expect(storage).not.toContain(PASSPHRASE);
  expect(storage).not.toContain("AGE-SECRET-KEY");

  // The policy was kept throughout.
  expect(await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations)).toEqual([]);

  // Lock, then remove: nothing is kept.
  await page.getByRole("button", { name: "Lock" }).click();
  await expect(page.getByRole("button", { name: "Unlock" })).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Remove from this browser" }).click();
  await expect(page.getByRole("button", { name: "Make an identity" })).toBeVisible({ timeout: 60_000 });
});

test("the module is served from this origin, with the types a browser needs, and nothing here needs a signed-in session to be a file", async ({ request }) => {
  const script = await request.get("/fjord-wasm/fjord_wasm.js");
  expect(script.status()).toBe(200);
  expect(script.headers()["content-type"]).toMatch(/javascript/);
  const wasm = await request.get("/fjord-wasm/fjord_wasm_bg.wasm");
  expect(wasm.status()).toBe(200);
  expect(wasm.headers()["content-type"]).toMatch(/application\/wasm/);
});
