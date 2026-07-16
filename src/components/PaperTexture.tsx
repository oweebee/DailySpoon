/**
 * Texture "papier froissé" en fond de tout le site (visible dans les marges
 * autour du bloc de contenu, et légèrement à travers les fonds "bg-paper/70"
 * du contenu lui-même). Générée en live via un filtre SVG (bruit fractal +
 * éclairage diffus) plutôt qu'une image bitmap : un fond fixe qui couvre tout
 * le viewport en un seul passage n'a par construction aucune répétition
 * visible (contrairement à une photo de papier froissé tuilée en petit
 * pavé, où les raccords finissent toujours par se voir).
 *
 * - feTurbulence (fractalNoise) : le froissé/grain du papier.
 * - feDiffuseLighting + feDistantLight : transforme ce bruit en relief
 *   (ombres dans les plis, reflets sur les bosses) plutôt qu'un bruit plat.
 * - feColorMatrix : ramène le résultat (0 = noir, 1 = blanc) dans une plage
 *   de gris très clairs (~0.85 à 1.0) pour rester dans le ton "papier"
 *   (#f0f0f0) du site plutôt qu'un contraste fort.
 */
export function PaperTexture() {
  return (
    <svg aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 h-full w-full">
      <filter id="paper-crumple" x="0" y="0" width="100%" height="100%">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.012 0.016"
          numOctaves={5}
          seed={11}
          stitchTiles="stitch"
          result="noise"
        />
        <feDiffuseLighting in="noise" surfaceScale="2.4" diffuseConstant="1.15" lightingColor="#ffffff" result="light">
          <feDistantLight azimuth="235" elevation="58" />
        </feDiffuseLighting>
        <feColorMatrix
          in="light"
          type="matrix"
          values="0.14 0 0 0 0.85  0 0.14 0 0 0.85  0 0 0.14 0 0.85  0 0 0 1 0"
        />
      </filter>
      <rect width="100%" height="100%" filter="url(#paper-crumple)" />
    </svg>
  );
}
