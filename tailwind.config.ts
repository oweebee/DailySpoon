import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        serif: ["Georgia", "Cambria", "Times New Roman", "Times", "serif"],
        // "Swell Type" et "Newshound" (mockups fournis) sont des polices
        // payantes non disponibles ici — Rye et Anton sont les équivalents
        // gratuits (Google Fonts) les plus proches dans le même esprit :
        // Rye pour le masthead (gothique/western, très typé), Anton pour
        // le reste des titres (gros titre de tabloïd condensé et massif).
        display: ["Anton", "Georgia", "serif"],
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
