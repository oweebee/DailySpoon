import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ArticleModalProvider } from "@/components/ArticleModalContext";
import { PwaRegister } from "@/components/PwaRegister";

export const metadata: Metadata = {
  title: "DailySpoon — le journal du jour",
  description: "Votre édition quotidienne personnalisée, générée automatiquement.",
  manifest: "/manifest.json",
  // Le favicon standard (onglet navigateur) vient UNIQUEMENT de
  // src/app/icon.svg (convention de fichier Next.js, génère automatiquement
  // la balise <link rel="icon">) — pas de tableau "icon" ici, sinon les deux
  // se cumulent et le navigateur peut afficher l'un ou l'autre au hasard
  // selon le cache (c'est exactement le bug qu'on vient de corriger : un
  // vieux src/app/icon.svg traînait en plus de ce tableau). "apple" reste
  // explicite : convention Next.js séparée (icône iOS "Ajouter à l'écran
  // d'accueil"), aucun fichier app/apple-icon.* n'existe donc pas de
  // doublon possible pour celle-là.
  icons: {
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
