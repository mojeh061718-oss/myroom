import type { ButtonHTMLAttributes, ReactNode } from "react";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  children: ReactNode;
}

/** docs/02 §8 PillButton — the accent (primary) variant appears once per screen. */
export function PillButton({ variant = "secondary", className = "", children, ...rest }: Props) {
  return (
    <button className={`pill-button ${variant} ${className}`} {...rest}>
      {children}
    </button>
  );
}
