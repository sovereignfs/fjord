import type { ReactNode } from 'react';
import { AuthCard, AuthFooter, BrandBadge } from '@sovereignfs/ui';
import { markOf } from '../../ui/brand';

/**
 * The frame of a screen before sign-in: the design system's card (the one Sovereign's own
 * sign-in uses), with the instance's mark above the title. `footer` is the small print under
 * the form, such as a link back to sign in. There are no legal links: this app has no pages for
 * them yet, and a link to a page that is not there is worse than none.
 */
export function AuthShell({
  title,
  lead,
  children,
  footer,
  footerAlign,
  wide,
  name = 'Fjord',
}: {
  title: string;
  lead?: string;
  children?: ReactNode;
  footer?: ReactNode;
  /** `start` for a screen that is only a message and a link, so the link lines up under the text. */
  footerAlign?: 'start';
  wide?: boolean;
  /** The instance's name (`FJORD_NAME`), whose first two letters are the mark: "Fj". */
  name?: string;
}) {
  return (
    <AuthCard
      brand={<BrandBadge name={name} mark={markOf(name)} />}
      title={title}
      {...(lead ? { lead } : {})}
      legal={false}
      wide={wide === true}
    >
      {children}
      {footer ? (
        <AuthFooter {...(footerAlign ? { align: footerAlign } : {})}>{footer}</AuthFooter>
      ) : null}
    </AuthCard>
  );
}
