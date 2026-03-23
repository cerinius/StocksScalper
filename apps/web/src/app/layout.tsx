import "./globals.css";
import Link from "next/link";
import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import type { ReactNode } from "react";

const headingFont = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-heading",
});

const monoFont = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500"],
});

export const metadata = {
  title: "Stock Radar Control Tower",
  description: "Trading intelligence, validation, execution, and oversight platform",
};

const navItems = [
  { href: "/", label: "Dashboard" },
  { href: "/workers", label: "Workers" },
  { href: "/news", label: "News" },
  { href: "/trade-ideas", label: "Trade Ideas" },
  { href: "/validation", label: "Validation" },
  { href: "/execution", label: "Execution" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/integrations", label: "Integrations" },
  { href: "/audit", label: "Audit" },
  { href: "/notifications", label: "Notifications" },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${headingFont.variable} ${monoFont.variable}`}>
        <div className="app-shell">
          <aside className="sidebar">
            <div>
              <div className="brand-mark">SR</div>
              <div className="brand-copy">
                <strong>Control Tower</strong>
                <span>Local-first trading operations</span>
              </div>
            </div>
            <nav className="nav-links">
              {navItems.map((item) => (
                <Link href={item.href} key={item.href}>
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="sidebar-footer">
              Explainable decisions, hard risk limits, and full auditability.
            </div>
          </aside>
          <main className="content-shell">{children}</main>
        </div>
      </body>
    </html>
  );
}
