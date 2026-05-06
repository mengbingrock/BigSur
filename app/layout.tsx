import type { Metadata } from "next";
import "./globals.css";
import Nav from "@/components/Nav";
import { getCurrentUser } from "@/lib/session";

export const metadata: Metadata = {
  title: "Monterey — Research Skills at Scale",
  description:
    "A catalog of Claude Code research skills installed on this machine.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  return (
    <html lang="en">
      <body className="min-h-screen bg-paper text-ink">
        <Nav user={user} />
        <main>{children}</main>
        <footer className="mt-24 border-t border-rule">
          <div className="flex w-full items-center justify-between px-6 py-6 text-xs text-muted sm:px-8 lg:px-12">
            <span>Monterey · local skills catalog</span>
            <span className="font-mono">v0.1</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
