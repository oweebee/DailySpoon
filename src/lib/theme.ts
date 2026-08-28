/**
 * Définition des thèmes visuels et de leurs déclinaisons de couleur.
 *
 * Ce module ne dépend de RIEN (ni Prisma, ni React) : il est importé aussi
 * bien par le layout (composant serveur), que par le lecteur d'article
 * (route API qui sert du HTML autonome), que par la page de réglages
 * (composant client). Y mettre le moindre import de base de données rendrait
 * impossible son usage côté navigateur.
 *
 * Les couleurs vivent ICI et nulle part ailleurs. Elles étaient auparavant
 * écrites en dur dans globals.css ET recopiées dans le lecteur d'article, qui
 * ne peut pas lire les variables CSS de l'application (HTML autonome servi en
 * iframe) — deux endroits à maintenir en parallèle, donc deux occasions de
 * diverger. Le layout injecte désormais ces valeurs en variables CSS sur
 * <html>, et le lecteur les lit dans le même objet.
 */

export const THEMES = ["dailyspoon", "material"] as const;
export type ThemeName = (typeof THEMES)[number];

/** Ramène n'importe quelle valeur stockée à un thème connu. Le défaut est
 *  "material" : c'est l'habillage retenu pour l'application, et une valeur
 *  absente (colonne jamais renseignée) doit donc y mener, pas à l'ancien
 *  habillage journal — lequel reste disponible en choix explicite. */
export function normalizeTheme(value: string | null | undefined): ThemeName {
  return THEMES.includes(value as ThemeName) ? (value as ThemeName) : "material";
}

/**
 * Palette d'une déclinaison du thème Material. Composantes RVB séparées par
 * des espaces (et non "#rrggbb") : c'est la forme qu'attend Tailwind pour
 * pouvoir appliquer ses modificateurs d'opacité (bg-ink/[0.07],
 * text-sepia/70…). Voir tailwind.config.ts.
 */
export type Palette = {
  /** Fond de la page, marges comprises — le plus sombre. */
  paper: string;
  /** Fond du bloc de contenu, légèrement plus clair : c'est ce contraste qui
   *  détache la colonne de lecture (convention Material : une surface posée
   *  au-dessus d'une autre s'éclaircit, elle ne se borde pas d'un trait). */
  surface: string;
  /** Texte principal — gris très clair teinté, jamais blanc pur. */
  ink: string;
  /** Séparateurs discrets. */
  rule: string;
  /** Texte secondaire. */
  sepia: string;
  /** Accent unique (entrée de menu active, étoile favori, tampons). Toujours
   *  assez clair pour ressortir sur le fond sombre ET assez saturé pour
   *  rester franc par-dessus une photo en noir et blanc. */
  journal: string;
};

/**
 * Six déclinaisons, toutes sur base sombre. Les niveaux (fond très sombre,
 * surface un cran au-dessus, texte clair désaturé) suivent les conventions du
 * Material sombre d'origine ; seule la teinte change. "ardoise" est le défaut
 * et correspond exactement au gris quasi noir d'avant l'ajout de ce réglage.
 */
export const MATERIAL_ACCENTS: Record<string, { label: string; palette: Palette }> = {
  ardoise: {
    label: "Ardoise (défaut)",
    palette: {
      paper: "10 10 10",
      surface: "30 30 30",
      ink: "226 226 226",
      rule: "60 60 60",
      sepia: "150 150 150",
      journal: "214 64 64"
    }
  },
  bleu: {
    label: "Bleu nuit",
    palette: {
      paper: "9 13 20",
      surface: "22 30 44",
      ink: "219 226 238",
      rule: "48 60 78",
      sepia: "146 160 180",
      journal: "122 176 255"
    }
  },
  vert: {
    label: "Vert profond",
    palette: {
      paper: "8 16 13",
      surface: "20 34 29",
      ink: "218 230 224",
      rule: "46 68 60",
      sepia: "144 166 156",
      journal: "106 200 150"
    }
  },
  violet: {
    label: "Violet",
    palette: {
      paper: "14 10 20",
      surface: "32 24 44",
      ink: "228 222 238",
      rule: "62 52 80",
      sepia: "158 148 176",
      journal: "187 148 255"
    }
  },
  ambre: {
    label: "Ambre",
    palette: {
      paper: "18 14 8",
      surface: "38 30 20",
      ink: "236 228 214",
      rule: "72 60 44",
      sepia: "174 162 142",
      journal: "255 183 77"
    }
  },
  rose: {
    label: "Rose poudré",
    palette: {
      paper: "20 10 14",
      surface: "42 24 32",
      ink: "238 222 228",
      rule: "78 52 62",
      sepia: "176 150 158",
      journal: "244 143 177"
    }
  }
};

export const ACCENT_NAMES = Object.keys(MATERIAL_ACCENTS);
export type AccentName = string;

export function normalizeAccent(value: string | null | undefined): AccentName {
  return value && MATERIAL_ACCENTS[value] ? value : "ardoise";
}

export function paletteFor(accent: string | null | undefined): Palette {
  return MATERIAL_ACCENTS[normalizeAccent(accent)].palette;
}

/**
 * Variables CSS à poser directement sur <html> (attribut style) pour la
 * déclinaison choisie. Style INLINE et non feuille de style : il l'emporte
 * sur les règles de globals.css sans avoir à jouer sur la spécificité ni
 * l'ordre d'injection des feuilles par Next.
 *
 * Renvoie un objet vide pour le thème journal : ses couleurs restent
 * définies dans :root (globals.css), rien à surcharger.
 */
export function themeCssVars(theme: ThemeName, accent: string | null | undefined): Record<string, string> {
  if (theme !== "material") return {};
  const p = paletteFor(accent);
  return {
    "--color-paper": p.paper,
    "--color-surface": p.surface,
    "--color-ink": p.ink,
    "--color-rule": p.rule,
    "--color-sepia": p.sepia,
    "--color-journal": p.journal
  };
}

/** "10 10 10" -> "rgb(10 10 10)", pour le HTML autonome du lecteur d'article
 *  qui, lui, écrit des couleurs CSS classiques et non des composantes. */
export function rgb(components: string): string {
  return `rgb(${components})`;
}
