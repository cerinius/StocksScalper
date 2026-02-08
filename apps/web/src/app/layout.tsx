import "./globals.css";
import Link from "next/link";

export const metadata = {
  title: "Stock Radar",
  description: "US swing-first scanner with scalping support",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <header>
          <div>
            <h1>Stock Radar</h1>
            <p>US swing-first scanner + scalping support</p>
          </div>
          <nav>
            <Link href="/">Home</Link>
            <Link href="/setups">Setups</Link>
            <Link href="/journal">Journal</Link>
          </nav>
        </header>
        <main>{children}</main>
        <div className="footer">
          This tool is for research/education. Not financial advice. Markets are risky.
        </div>
      </body>
    </html>
  );
}
