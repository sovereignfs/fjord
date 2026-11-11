import { expect, test } from '@playwright/test';

/**
 * Fjord Web as an installable app (src/pwa/): the manifest a browser installs from, and the service worker that shows an offline page in place of a page that
 * could not be reached, and keeps nothing of anyone's. Run on a production build, where the worker is registered.
 */
test.describe('the app as a PWA', () => {
  test('links a web app manifest that a browser can install from, with icons that load', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(href).toBe('/manifest.webmanifest');
    const response = await request.get(href!);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('manifest+json');
    const manifest = await response.json();
    expect(manifest).toMatchObject({ name: 'Fjord', display: 'standalone', start_url: '/' });
    for (const icon of manifest.icons as { src: string }[])
      expect((await request.get(icon.src)).status(), icon.src).toBe(200);
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
      'href',
      '/icons/apple-touch-icon.png',
    );
    await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute(
      'content',
      /#(?:ffffff|09090b)/,
    );
  });

  test('registers a service worker that the policy allows, and which takes over the page', async ({
    page,
  }) => {
    const blocked: string[] = [];
    page.on('console', (message) => {
      if (/content security policy/i.test(message.text())) blocked.push(message.text());
    });
    await page.goto('/');
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    expect(scope).toBe(`${new URL(page.url()).origin}/`);
    expect(blocked).toEqual([]);
  });

  test('shows the offline page, and only that, when a page cannot be reached', async ({
    page,
    context,
  }) => {
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    // The worker controls pages from the next load on.
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

    await context.setOffline(true);
    await page.goto('/sign-in').catch(() => undefined);
    await expect(page.getByRole('heading', { name: 'You are offline' })).toBeVisible();
    await context.setOffline(false);

    // What the worker keeps: the offline page and files that are the same for everyone. No page, no API answer.
    const kept = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys())
        for (const request of await (await caches.open(name)).keys())
          urls.push(new URL(request.url).pathname);
      return urls;
    });
    expect(kept).toContain('/offline');
    for (const path of kept) expect(path, path).toMatch(/^\/(?:offline|_next\/static\/|icons\/)/);
  });
});
