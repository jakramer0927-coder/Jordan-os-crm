import "./globals.css";
import ClientLayout from "./ClientLayout";

export const metadata = {
  title: "Jordan OS CRM",
  description: "Personal CRM + recommendation engine",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ClientLayout>{children}</ClientLayout>
      </body>
    </html>
  );
}
