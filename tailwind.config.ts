import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        serif: ["Georgia", "Cambria", "Times New Roman", "Times", "serif"],
        // Rye et Anton (essayés d'après des mockups) étaient jugés trop
        // massifs/gras à l'usage sur les titres courants (font-display,
        // utilisée partout : rubriques, article, nav...) — reste sur
        // Playfair Display pour ceux-là. Le masthead ("DailySpoon" en
        // très grand en haut de chaque page) est un cas à part : un seul
        // gros logotype, pas du texte courant — Rye (western/far-west,
        // façon affiche de saloon) y est repris ici sans ce problème de
        // lisibilité.
        display: ['"Playfair Display"', "Georgia", "serif"],
        masthead: ['"Rye"', "Georgia", "serif"],
        sans: ["-apple-system", "Segoe UI", "Helvetica", "Arial", "sans-serif"]
      },
      colors: {
        // Thème en niveaux de gris : seul le rouge ("journal") reste en
        // couleur, comme accent unique (menu, tampon, étoile favori,
        // ruban de médaille...). Le reste (papier, filets, texte discret)
        // est du gris neutre pur (R=G=B), plus de teinte sépia/beige.
        paper: "#f0f0f0",
        ink: "#1a1a1a",
        rule: "#1a1a1a",
        sepia: "#5c5c5c",
        journal: "#8b1a1a"
      }
    }
  },
  plugins: []
};

export default config;
