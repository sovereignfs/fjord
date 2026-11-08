import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BuildStatus } from '../../providers/types';
import { BuildStatusView } from './BuildStatusView';

/** The build of a site's latest commit, as the page says it (ROADMAP 3c.3): from a recorded host answer, in each of its states. */
const status = (over: Partial<BuildStatus>): BuildStatus => ({
  commit: 'a'.repeat(40),
  state: 'success',
  checks: [],
  ...over,
});

describe("the site's build status", () => {
  it('shows nothing for a host that reports nothing', () => {
    expect(renderToStaticMarkup(<BuildStatusView status={status({ state: 'none' })} />)).toBe('');
    expect(renderToStaticMarkup(<BuildStatusView />)).toBe('');
  });

  it('says the site is building while any check is not done', () => {
    const html = renderToStaticMarkup(
      <BuildStatusView
        status={status({ state: 'pending', checks: [{ name: 'deploy', state: 'pending' }] })}
      />,
    );
    expect(html).toContain('The site is building');
    expect(html).toContain('Running');
  });

  it('says the site is built, and where it is when the host says', () => {
    const html = renderToStaticMarkup(
      <BuildStatusView
        status={status({
          checks: [{ name: 'build', state: 'success' }],
          siteUrl: 'https://abc.pages.example',
        })}
      />,
    );
    expect(html).toContain('The site is built');
    expect(html).toContain('href="https://abc.pages.example"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(
      renderToStaticMarkup(
        <BuildStatusView status={status({ checks: [{ name: 'build', state: 'success' }] })} />,
      ),
    ).toContain('did not say where the site is');
  });

  it("says the build failed, with the host's link to why", () => {
    const html = renderToStaticMarkup(
      <BuildStatusView
        status={status({
          state: 'failure',
          checks: [
            { name: 'build', state: 'failure', url: 'https://ci.example/runs/9' },
            { name: 'lint', state: 'success' },
          ],
        })}
      />,
    );
    expect(html).toContain('The build failed');
    expect(html).toContain('One check failed');
    expect(html).toContain('href="https://ci.example/runs/9"');
  });

  it('says a token that may not read the build is that, and not that nothing was built', () => {
    const html = renderToStaticMarkup(<BuildStatusView unreadable />);
    expect(html).toContain('cannot be read with this repository');
    expect(html).toContain('Checks, Commit statuses and Deployments');
    expect(html).not.toContain('built');
  });
});
