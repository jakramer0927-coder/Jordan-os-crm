// app/layout.tsx
import "./globals.css";

export const metadata = {
  title: "Jordan OS CRM",
  description: "Personal CRM + recommendation engine",
};

function NavLink({ href, label }: { href: string; label: string }) {
  return (
    <a className="navLink" href={href}>
      {label}
    </a>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <div className="container">
            <div className="topbarInner">
              <div className="brand">
                <div className="brandMark">Jordan OS</div>
                <div className="brandSub">Smith &amp; Berg — Private CRM</div>
              </div>

              <nav className="nav" aria-label="Primary">
                <NavLink href="/morning" label="Morning" />
                <NavLink href="/contacts" label="Contacts" />
                <NavLink href="/unmatched" label="Unmatched" />
                <NavLink href="/insights" label="Insights" />
                <NavLink href="/settings/integrations" label="Integrations" />
              </nav>
            </div>
          </div>
        </header>

        <main className="container page">{children}</main>
      </body>
    </html>
  );
}