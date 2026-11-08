import { Alert, Badge } from '@sovereignfs/ui';
import styles from '../../auth/screens/screens.module.css';
import type { BuildStatus } from '../../providers/types';

/**
 * What the host says of the site's latest commit (ROADMAP 3c.3, Research 0001): building, built (with the site's address when the host gives one),
 * or failed (with the host's link to why). Fjord configures nothing and builds nothing; it shows what the host's own integrations reported, and a
 * host that reports nothing shows nothing. `unreadable` is a token that may not read them, which is not the same as nothing built.
 */
export function BuildStatusView({
  status,
  unreadable,
}: {
  status?: BuildStatus | undefined;
  unreadable?: boolean | undefined;
}) {
  if (unreadable) {
    return (
      <p className={styles.itemMeta} data-testid="build-status">
        The build's status cannot be read with this repository's token. To see it here, give the
        token read access to Checks, Commit statuses and Deployments, and connect the repository
        again.
      </p>
    );
  }
  if (!status || status.state === 'none') return null;
  const failed = status.checks.filter((check) => check.state === 'failure');
  return (
    <section aria-label="Build" data-testid="build-status">
      {status.state === 'pending' ? (
        <Alert variant="info" heading="The site is building">
          The host is still working on the latest commit. Reload in a moment.
        </Alert>
      ) : status.state === 'success' ? (
        <Alert variant="success" heading="The site is built">
          {status.siteUrl ? (
            <>
              It is at{' '}
              <a href={status.siteUrl} target="_blank" rel="noopener noreferrer">
                {status.siteUrl}
              </a>
              .
            </>
          ) : (
            'The host built the latest commit. It did not say where the site is.'
          )}
        </Alert>
      ) : (
        <Alert variant="error" heading="The build failed">
          {failed.length === 1 ? 'One check failed' : `${failed.length} checks failed`} on the
          latest commit, so the site shows an earlier version.
        </Alert>
      )}
      <ul className={styles.list} aria-label="What the host reports">
        {status.checks.map((check) => (
          <li key={check.name} className={styles.item}>
            <span>
              {check.url ? (
                <a href={check.url} target="_blank" rel="noopener noreferrer">
                  {check.name}
                </a>
              ) : (
                check.name
              )}{' '}
              <Badge>
                {check.state === 'pending'
                  ? 'Running'
                  : check.state === 'success'
                    ? 'Passed'
                    : 'Failed'}
              </Badge>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
