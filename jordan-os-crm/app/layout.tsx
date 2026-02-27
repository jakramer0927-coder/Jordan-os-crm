import "./globals.css";

export const metadata = {
  title: "Jordan OS CRM",
  description: "Personal CRM + recommendation engine",
};

function NavLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      style={{
        padding: "10px 12px",
        borderRadius: 10,
        border: "1px solid #e5e5e5",
        textDecoration: "none",
        color: "#111",
        fontWeight: 900,
        fontSize: 13,
      }}
    >
      {label}
    </a>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#fff" }}>
        <div style={{ borderBottom: "1px solid #eee", background: "#fff" }}>
          <div
            style={{
              maxWidth: 1100,
              margin: "0 auto",
              padding: "14px 16px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div style={{ fontWeight: 900, letterSpacing: 0.2 }}>Jordan OS</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <NavLink href="/morning" label="Morning" />
                <NavLink href="/contacts" label="Contacts" />
                <NavLink href="/unmatched" label="Unmatched" />
                <NavLink href="/insights" label="Insights" />
                <NavLink href="/settings/integrations" label="Integrations" />
              </div>
            </div>

            <div style={{ color: "#777", fontSize: 12, fontWeight: 700 }}>Private CRM</div>
          </div>
        </div>

        <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 16px" }}>{children}</div>
      </body>
    </html>
  );
}