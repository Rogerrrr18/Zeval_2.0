/**
 * @fileoverview Unified app shell: top navigation + content frame for all consoles.
 */

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import styles from "./appShell.module.css";

const NAV_ITEMS = [
  { label: "工作台", href: "/workbench", match: "/workbench" },
  { label: "案例池", href: "/datasets", match: "/datasets" },
  { label: "在线评测", href: "/online-eval", match: "/online-eval" },
  { label: "调优包", href: "/remediation-packages", match: "/remediation-packages" },
];

type AppShellProps = {
  children: ReactNode;
  /** Optional slot rendered directly under the top header (e.g. Stepper). */
  subheader?: ReactNode;
};

/**
 * Render the unified application shell with sticky top navigation.
 */
export function AppShell({ children, subheader }: AppShellProps) {
  const pathname = usePathname();

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link href="/" className={styles.brand} aria-label="ZERORE home">
            <span className={styles.brandMark}>ZE</span>
            <span className={styles.brandWord}>ZERORE</span>
          </Link>
          <nav className={styles.nav} aria-label="primary">
            {NAV_ITEMS.map((item) => {
              const active = pathname?.startsWith(item.match);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`${styles.navLink} ${active ? styles.navLinkActive : ""}`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className={styles.headerActions}>
            <Link href="/" className={styles.homeLink}>
              ← 产品首页
            </Link>
          </div>
        </div>
        {subheader ? <div className={styles.subheader}>{subheader}</div> : null}
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
