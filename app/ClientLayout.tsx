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
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [qaName, setQaName] = useState("");
  const [qaCategory, setQaCategory] = useState("sphere");
  const [qaTier, setQaTier] = useState("B");
  const [qaPhone, setQaPhone] = useState("");
  const [qaEmail, setQaEmail] = useState("");
  const [qaNotes, setQaNotes] = useState("");
  const [qaSaving, setQaSaving] = useState(false);
  const [qaError, setQaError] = useState<string | null>(null);
  const [qaSuccess, setQaSuccess] = useState<string | null>(null);

  async function handleLogout() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut({ scope: "global" });
    window.location.href = "/login";
  }

  function openQuickAdd() {
    setQaName(""); setQaCategory("sphere"); setQaTier("B");
    setQaPhone(""); setQaEmail(""); setQaNotes("");
    setQaError(null); setQaSuccess(null);
    setQuickAddOpen(true);
  }

  async function saveQuickAdd() {
    if (!qaName.trim()) { setQaError("Name is required."); return; }
    setQaSaving(true);
    setQaError(null);
    const res = await fetch("/api/contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        display_name: qaName.trim(),
        category: qaCategory,
        tier: qaTier || null,
        phone: qaPhone.trim() || null,
        email: qaEmail.trim() || null,
        notes: qaNotes.trim() || null,
      }),
    });
    const j = await res.json().catch(() => ({}));
    setQaSaving(false);
    if (!res.ok) { setQaError(j?.error || "Save failed"); return; }
    setQaSuccess(`${qaName.trim()} added ✓`);
    setQaName(""); setQaPhone(""); setQaEmail(""); setQaNotes("");
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
            {/* Quick-add contact button */}
            <button
              className="btn btnPrimary"
              onClick={openQuickAdd}
              style={{ fontSize: 12, padding: "6px 12px" }}
            >
              + Contact
            </button>

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
              className="btn btnPrimary"
              onClick={() => { setMenuOpen(false); openQuickAdd(); }}
              style={{ fontSize: 13, padding: "10px 16px", textAlign: "left", justifyContent: "flex-start" }}
            >
              + Add contact
            </button>
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

      {/* Quick-add contact modal */}
      {quickAddOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 1000 }}>
          <div style={{ background: "var(--paper)", borderRadius: 12, padding: 24, width: "min(480px, 100%)", boxShadow: "0 8px 40px rgba(0,0,0,.18)" }}>
            <div style={{ fontWeight: 900, fontSize: 17, marginBottom: 16 }}>Add contact</div>

            {qaError && <div style={{ color: "#8a0000", fontSize: 13, fontWeight: 700, marginBottom: 10 }}>{qaError}</div>}
            {qaSuccess && <div style={{ color: "#0b6b2a", fontSize: 13, fontWeight: 700, marginBottom: 10 }}>{qaSuccess}</div>}

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Name *</div>
                <input
                  className="input"
                  placeholder="Full name"
                  value={qaName}
                  onChange={e => setQaName(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && saveQuickAdd()}
                  autoFocus
                />
              </div>

              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 120 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Category</div>
                  <select className="select" value={qaCategory} onChange={e => setQaCategory(e.target.value)}>
                    <option value="client">Client</option>
                    <option value="sphere">Sphere</option>
                    <option value="agent">Agent</option>
                    <option value="developer">Developer</option>
                    <option value="vendor">Vendor</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div style={{ width: 80 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Tier</div>
                  <select className="select" value={qaTier} onChange={e => setQaTier(e.target.value)}>
                    <option value="A">A</option>
                    <option value="B">B</option>
                    <option value="C">C</option>
                    <option value="">—</option>
                  </select>
                </div>
              </div>

              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 140 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Phone</div>
                  <input className="input" placeholder="(555) 000-0000" value={qaPhone} onChange={e => setQaPhone(e.target.value)} />
                </div>
                <div style={{ flex: 1, minWidth: 140 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Email</div>
                  <input className="input" type="email" placeholder="name@email.com" value={qaEmail} onChange={e => setQaEmail(e.target.value)} />
                </div>
              </div>

              <div>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Notes</div>
                <input className="input" placeholder="How you know them, context…" value={qaNotes} onChange={e => setQaNotes(e.target.value)} />
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
              <button className="btn btnPrimary" onClick={saveQuickAdd} disabled={qaSaving}>
                {qaSaving ? "Saving…" : "Add contact"}
              </button>
              <button className="btn" onClick={() => setQuickAddOpen(false)}>Done</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
