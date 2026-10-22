/**
 * Sets `data-theme` on the root element from the visitor's colour scheme, before the
 * page is painted, and keeps it in step when the system changes. The design system's
 * tokens switch on `[data-theme='dark']` and have no `prefers-color-scheme` rule of
 * their own, so without this a dark-mode visitor gets a light page.
 *
 * It is a script, not an effect, because an effect runs after the first paint and the
 * page would flash light. It is inline, so a strict Content-Security-Policy (DESIGN.md §15,
 * ROADMAP 1d.5) must give it the same nonce Next gives its own inline scripts.
 *
 * It follows the system only. A saved choice belongs to the account settings, later.
 */
export const themeScript = `(function () {
  try {
    var query = window.matchMedia('(prefers-color-scheme: dark)');
    var apply = function () {
      document.documentElement.setAttribute('data-theme', query.matches ? 'dark' : 'light');
    };
    apply();
    query.addEventListener('change', apply);
  } catch (error) {}
})();`;
