"use client";

import { usePathname } from "next/navigation";

function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = pathname === href || (href !== "/" && pathname.startsWith(href));
  return (
    <a href={href} className={`navLink${active ? " navLinkActive" : ""}`}>
      {label}
    </a>
  );
}

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="topbar">
        <div className="topbarInner">
          <div className="brandRow">
            <div>
              <div className="brandName">Jordan OS</div>
              <div className="brandSub">Smith &amp; Berg — Private CRM</div>
            </div>

            <nav className="nav">
              <NavLink href="/morning" label="Morning" />
              <NavLink href="/contacts" label="Contacts" />
              <NavLink href="/unmatched" label="Unmatched" />
              <NavLink href="/insights" label="Insights" />
              <NavLink href="/settings/integrations" label="Integrations" />
            </nav>
          </div>

          <div className="topbarRight">Private CRM</div>
        </div>
      </header>

      <main className="appShell">{children}</main>
    </>
  );
}
