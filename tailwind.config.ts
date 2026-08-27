import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        serif: "var(--font-serif)",
        // Rye et Anton (essayés d'après des mockups) étaient jugés trop
        // massifs/gras à l'usage sur les titres courants (font-display,
        // utilisée partout : rubriques, article, nav...) — reste sur
        // Playfair Display pour ceux-là. Le masthead ("DailySpoon" en
        // très grand en haut de chaque page) est un cas à part : un seul
        // gros logotype, pas du texte courant — Rye (western/far-west,
        // façon affiche de saloon) y est repris ici sans ce problème de
        // lisibilité.
        // Mêmes familles qu'avant, mais passées par des variables CSS pour
        // que le thème Material puisse toutes les remplacer par une seule
        // police (voir globals.css) sans qu'aucun composant n'ait à changer
        // de classe. Les valeurs par défaut de ces variables reproduisent
        // exactement les piles ci-dessous.
        display: "var(--font-display)",
        masthead: "var(--font-masthead)",
        sans: "var(--font-sans)"
      },
      colors: {
        // Thème en niveaux de gris : seul le rouge ("journal") reste en
        // couleur, comme accent unique (menu, tampon, étoile favori,
        // ruban de médaille...). Le reste (papier, filets, texte discret)
        // est du gris neutre pur (R=G=B), plus de teinte sépia/beige.
        //
        // Les valeurs ne sont plus écrites en dur ici mais lues dans des
        // variables CSS (définies dans globals.css), pour qu'un simple
        // attribut data-theme sur <html> puisse repeindre toute
        // l'application sans toucher à une seule classe dans les composants.
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
