import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ArticleModalProvider } from "@/components/ArticleModalContext";
import { PwaRegister } from "@/components/PwaRegister";

export const metadata: Metadata = {
  title: "DailySpoon — le journal du jour",
  description: "Votre édition quotidienne personnalisée, générée automatiquement.",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" }
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }]
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "DailySpoon"
  },
  // Next.js ne génère que "apple-mobile-web-app-capable" via appleWebApp
  // ci-dessus — cette balise générique (non préfixée "apple-") est celle que
  // Chrome/Firefox pour Android vérifient aussi pour juger qu'une page est
  // une vraie "web app" installable plutôt qu'un simple raccourci-favori.
  other: {
    "mobile-web-app-capable": "yes"
  }
};

// Séparé de "metadata" (exigé par Next 14 pour themeColor/viewport, plus
// accepté dans l'export "metadata" classique).
export const viewport: Viewport = {
  themeColor: "#1a1a1a",
  width: "device-width",
  initialScale: 1,
  // Autorise le contenu à s'étendre sous l'encoche/la barre de statut en
  // mode plein écran (display: "fullscreen" dans le manifest) — sans ça,
  // iOS laisse une bande noire au lieu de vraiment passer bord à bord.
  viewportFit: "cover"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      {/* Texture papier froissé (public/textures/journal.png) en fond fixe :
          "cover" + "fixed" plutôt qu'une répétition en pavé, pour ne jamais
          voir de raccord — l'image entière couvre toujours tout l'écran, se
          recadre simplement selon sa taille, et reste immobile au défilement. */}
      <body
        className="min-h-screen bg-paper bg-cover bg-center bg-no-repeat bg-fixed text-ink font-serif"
        style={{ backgroundImage: "url(/textures/journal.png)" }}
      >
        <ArticleModalProvider>{children}</ArticleModalProvider>
        <PwaRegister />
      </body>
    </html>
  );
}
