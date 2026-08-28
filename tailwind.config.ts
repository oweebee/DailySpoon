import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        // Les quatre familles pointent toutes sur la même police (Inter, voir
        // globals.css) : l'application n'a plus qu'un seul habillage. Elles
        // restent distinctes pour que les composants continuent d'écrire
        // font-display ou font-masthead sans avoir à changer de classe, et
        // pour pouvoir les redifférencier un jour sans rien toucher ailleurs.
        serif: "var(--font-serif)",
        display: "var(--font-display)",
        masthead: "var(--font-masthead)",
        sans: "var(--font-sans)"
      },
      colors: {
        // Palette en niveaux de gris sombres ; seul "journal" reste en
        // couleur, comme accent unique (menu, tampon, étoile favori, ruban de
        // médaille...). Les valeurs vivent dans des variables CSS posées sur
        // <html> par le layout à partir de la déclinaison choisie en admin
        // (voir src/lib/theme.ts), avec un repli dans globals.css (:root).
        //
        // Écriture "rgb(var(--x) / <alpha-value>)" et non "var(--x)" tout
        // court : c'est ce qui permet à Tailwind de continuer à gérer les
        // modificateurs d'opacité employés un peu partout dans le projet
        // (bg-ink/[0.07] pour le fond des encadrés d'article, text-sepia/70,
        // border-ink/30...). Avec une variable contenant une couleur
        // complète, ces suffixes seraient silencieusement ignorés et tous
        // les aplats deviendraient opaques. D'où des variables qui ne
        // contiennent QUE les trois composantes, sans "rgb()".
        paper: "rgb(var(--color-paper) / <alpha-value>)",
        ink: "rgb(var(--color-ink) / <alpha-value>)",
        rule: "rgb(var(--color-rule) / <alpha-value>)",
        sepia: "rgb(var(--color-sepia) / <alpha-value>)",
        journal: "rgb(var(--color-journal) / <alpha-value>)"
      }
    }
  },
  plugins: []
};

export default config;
