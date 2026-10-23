import { expect, signUp, test } from "./helpers";

/** An instance with no encryption key: it says so, and cannot be made to keep a token. */
test("without an instance key, the page says why it cannot connect, and the API refuses", async ({ page }) => {
  await signUp(page);
  await page.goto("/repositories");
  await expect(page.getByText("Repositories cannot be connected yet")).toBeVisible();
  await expect(page.getByText("FJORD_ENCRYPTION_KEY")).toBeVisible();
  await expect(page.getByLabel("Access token")).toHaveCount(0);

  const response = await page.request.post("/api/connections", { headers: { origin: "http://localhost:3205" }, data: { repository: "acme/notes", token: "github_pat_x" } });
  expect(response.status()).toBe(503);
  expect((await response.json()).error.code).toBe("not_configured");
});
