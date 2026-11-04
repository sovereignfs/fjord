/**
 * Sets `data-theme` on the root element from the person's choice (Account, Preferences: `light` or `dark`, kept in this browser), or from the visitor's colour scheme when they
 * have made none, before the page is painted, and keeps it in step when the system changes. The design system's tokens switch on `[data-theme='dark']` and have no
 * `prefers-color-scheme` rule of their own, so without this a dark-mode visitor gets a light page. It also sets `data-text-size` (`large` or `larger`; the default is none) from
 * the other choice there, which `app/globals.css` turns into the root's font size.
 *
 * It is a script, not an effect, because an effect runs after the first paint and the page would flash light. It is inline, so a strict Content-Security-Policy (DESIGN.md §15,
 * ROADMAP 1d.5) must give it the same nonce Next gives its own inline scripts. The keys are `src/theme/preferences.ts`'s, which a test holds to this.
 */
export const themeScript = `(function () {
  var root = document.documentElement;
  var stored = function (key) {
    try { return window.localStorage.getItem(key); } catch (error) { return null; }
  };
  try {
    var size = stored('fjord.textSize');
    if (size === 'large' || size === 'larger') root.setAttribute('data-text-size', size);
    var query = window.matchMedia('(prefers-color-scheme: dark)');
    var apply = function () {
      var chosen = stored('fjord.theme');
      root.setAttribute('data-theme', chosen === 'light' || chosen === 'dark' ? chosen : query.matches ? 'dark' : 'light');
    };
    apply();
    query.addEventListener('change', apply);
  } catch (error) {}
})();`;
