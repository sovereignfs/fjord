import type { AnchorHTMLAttributes, ReactNode } from "react";
import styles from "./LinkButton.module.css";

export interface LinkButtonProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  variant?: "primary" | "secondary";
  size?: "md" | "lg";
  children: ReactNode;
}

/**
 * A link that looks like the design system's Button. `Button` always renders a
 * `<button>`, and a navigation is a link: it works without JavaScript, opens in a new
 * tab, and a button inside an anchor is invalid HTML. The look is the same tokens the
 * Button's styles use, so the two sit side by side without a seam.
 */
export function LinkButton({ variant = "primary", size = "md", className, children, ...rest }: LinkButtonProps) {
  const classes = [styles.link, styles[variant], styles[size], className].filter(Boolean).join(" ");
  return (
    <a className={classes} {...rest}>
      {children}
    </a>
  );
}
