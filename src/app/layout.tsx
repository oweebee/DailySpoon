import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ArticleModalProvider } from "@/components/ArticleModalContext";
import { PwaRegister } from "@/components/PwaRegister";

export const metadata: Metadata = {
  title: "DailySpoon — le journal du jour",
  description: "Votre édition quotidienne personnalisée, générée automatiquement.",
  manifest: "/manifest.json",
  // Favicon pointé explicitement vers src/app/icon.svg. Note : la convention
  // de fichier Next.js est censée générer automatiquement la balise <link
  // rel="icon"> toute seule à partir de ce fichier, MAIS en pratique, dès
  // qu'on déclare un objet "icons" ici (ne serait-ce que pour "apple"
  // ci-dessous), Next arrête de l'auto-générer — vérifié en direct sur le
  // site déployé (aucune balise <link rel="icon"> présente du tout). D'où la
  // déclaration EXPLICITE de "icon" ci-dessous, qui contourne le problème.
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
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
      {/* Le fond (texture papier) est entièrement géré par la règle "body"
          dans globals.css, pas ici — ne pas dupliquer/surcharger avec un
          style inline, ça avait écrasé ce fond par-dessus la règle CSS
          (spécificité du style inline) au lieu de la modifier proprement. */}
      <body className="min-h-screen bg-paper text-ink font-serif">
        <ArticleModalProvider>{children}</ArticleModalProvider>
        <PwaRegister />
      </body>
    </html>
  );
}
