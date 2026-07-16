import type { Metadata } from "next";
import "./globals.css";
import { ArticleModalProvider } from "@/components/ArticleModalContext";

export const metadata: Metadata = {
  title: "DailySpoon — le journal du jour",
  description: "Votre édition quotidienne personnalisée, générée automatiquement."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body className="min-h-screen bg-paper text-ink font-serif">
        <ArticleModalProvider>{children}</ArticleModalProvider>
      </body>
    </html>
  );
}
