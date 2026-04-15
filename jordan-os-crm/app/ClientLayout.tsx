"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

function NavLink({ href, label, onClick }: { href: string; label: string; onClick?: () => void }) {
  const pathname = usePathname();
  const active = pathname === href || (href !== "/" && pathname.startsWith(href));
  return (
    <a href={href} className={`navLink${active ? " navLinkActive" : ""}`} onClick={onClick}>
      {label}
    </a>
  );
}

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);

  async function handleLogout() {
    const supabase = createSupabaseBrowserClient();
    // global scope signs out all sessions (all devices/browsers)
    await supabase.auth.signOut({ scope: "global" });
    window.location.href = "/login";
  }

  const navLinks = [
    { href: "/morning", label: "Morning" },
    { href: "/contacts", label: "Contacts" },
    { href: "/pipeline", label: "Pipeline" },
    { href: "/unmatched", label: "Unmatched" },
    { href: "/insights", label: "Insights" },
    { href: "/settings/integrations", label: "Integrations" },
  ];

  return (
    <>
      <header className="topbar">
        <div className="topbarInner">
          <div className="brandRow">
            <div>
              <div className="brandName">Jordan OS</div>
              <div className="brandSub">Smith &amp; Berg — Private CRM</div>
            </div>

            {/* Desktop nav */}
            <nav className="nav navDesktop">
              {navLinks.map((l) => (
                <NavLink key={l.href} href={l.href} label={l.label} />
              ))}
            </nav>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* Desktop logout */}
            <button
              className="btn btnGhost navLogout"
              onClick={handleLogout}
              style={{ fontSize: 12, padding: "6px 12px" }}
            >
              Sign out
            </button>

            {/* Hamburger — mobile only */}
            <button
              className="btn hamburger"
              onClick={() => setMenuOpen((o) => !o)}
              aria-label="Toggle menu"
              style={{ padding: "8px 10px" }}
            >
              {menuOpen ? "✕" : "☰"}
            </button>
          </div>
        </div>

        {/* Mobile nav drawer */}
        {menuOpen && (
          <div className="mobileNav">
            {navLinks.map((l) => (
              <NavLink key={l.href} href={l.href} label={l.label} onClick={() => setMenuOpen(false)} />
            ))}
            <button
              className="btn btnGhost"
              onClick={handleLogout}
              style={{ fontSize: 13, padding: "10px 16px", textAlign: "left", justifyContent: "flex-start", color: "var(--red)" }}
            >
              Sign out (all devices)
            </button>
          </div>
        )}
      </header>

      <main className="appShell">{children}</main>
    </>
  );
}
