import Link from "next/link";

/** Remplace les "o" de "Sp[o][o]n" dans le masthead par la même silhouette
 *  de cuillère (bol + manche) que le cul-de-lampe SpoonDivider en bas de
 *  page, plutôt qu'un simple ovale — dimensionnée en unités "em" pour
 *  suivre la taille de la police du titre (text-5xl / md:text-7xl) et
 *  rester à la même hauteur que les autres lettres. */
function SpoonO() {
  return (
    <svg
      viewBox="0 0 24 24"
      preserveAspectRatio="none"
      aria-hidden="true"
      className="-mx-[0.04em] inline-block h-[1em] w-[0.48em] align-[-0.2em]"
    >
      <ellipse cx="12" cy="6.2" rx="5.1" ry="6.2" fill="currentColor" />
      <rect x="10.6" y="11.4" width="2.8" height="11.2" rx="1.4" fill="currentColor" />
    </svg>
  );
}

export function Masthead({
  date,
  compact = false
}: {
  date: Date;
  /** Version resserrée verticalement, utilisée uniquement pour la copie
   *  dupliquée en haut de chaque page du carrousel mobile (voir
   *  MobilePagedSection) — répétée à chaque swipe, elle repoussait le début
   *  des articles à plus de la moitié de l'écran sur téléphone. Le Masthead
   *  "normal" (desktop, une seule copie fixe) n'est pas concerné. */
  compact?: boolean;
}) {
  const formatted = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(date);

  return (
    <header className={compact ? "mb-3" : "mb-10"}>
      {/* Zone repère pour le timbre "EN DIRECT" en desktop : englobe le
          bandeau du haut, le titre ET le double filet, pour que le timbre
          puisse être centré verticalement sur toute cette hauteur (entre le
          bandeau et le menu du dessous), pas juste sur la ligne du titre. */}
      <div className="relative">
        {/* Bandeau supérieur */}
        <div
          className={`flex items-center justify-between border-b border-ink uppercase tracking-[0.25em] text-sepia ${
            compact ? "py-0.5 text-[0.55rem]" : "py-1 text-[0.65rem]"
          }`}
        >
          <span>Édition quotidienne personnelle</span>
          <span>Prix : ≈ 10 ¢</span>
        </div>

        {/* Masthead gothique centré — "relative" sert de repère de hauteur
            au timbre desktop ci-dessous (inset-y-0 SANS hauteur explicite =
            il exploite exactement la hauteur de cette cellule titre, ni
            plus ni moins, largeur recalculée automatiquement à partir du
            ratio réel de l'image via aspect-ratio). */}
        <div className={`relative text-center ${compact ? "py-2" : "py-6"}`}>
          <Link
            href="/"
            className={`font-masthead font-black uppercase tracking-tight ${compact ? "text-2xl" : "text-5xl md:text-7xl"}`}
          >
            DailySp
            <SpoonO />
            <SpoonO />n
          </Link>

          {/* Timbre "EN DIRECT" version mobile : bloc centré sous le titre,
              en flux normal (une position absolue le tronquait, pas assez de
              place à droite du titre en mobile). */}
          <Link
            href="/direct"
            className={`stamp-live stamp-bg-sm relative mx-auto flex items-center justify-center font-display uppercase text-white md:hidden ${
              compact ? "mt-1.5 h-9 px-3 text-[0.6rem] tracking-[0.2em]" : "mt-4 h-20 px-4 text-xs tracking-[0.25em]"
            }`}
          >
            <span className="stamp-live-text">En direct</span>
          </Link>

          {/* Timbre "EN DIRECT" version desktop — classe ".stamp-live"
              autonome (voir globals.css), qui NE se combine PAS avec
              ".stamp-button" : les deux se disputaient la propriété
              "transform" (rotation vs centrage vertical), ce qui empêchait
              la rotation de s'afficher. "inset-y-0" SANS hauteur explicite
              (ni h-fit ni h-*) étire le timbre sur TOUTE la hauteur de cette
              cellule titre (le "relative py-6" ci-dessus) — largeur
              recalculée automatiquement par le navigateur à partir du ratio
              réel de l'image (aspect-ratio sur .stamp-bg-sm), jamais
              déformée. Le fond (.stamp-live) reste droit ; seul le texte,
              enveloppé dans .stamp-live-text, garde l'inclinaison. Jamais en
              mode compact : ce timbre est caché en dessous de md (md:flex),
              et le mode compact n'existe justement que sous ce seuil. */}
          <Link
            href="/direct"
            className="stamp-live stamp-bg-sm absolute inset-y-0 -right-2.5 hidden items-center justify-center px-5 font-display text-sm uppercase tracking-[0.25em] text-white md:flex"
          >
            <span className="stamp-live-text">En direct</span>
          </Link>
        </div>

        <div className="double-rule" />
      </div>

      {/* Ligne de date entre deux filets — en mobile, la date et le menu ne
          tiennent pas côte à côte (la date se repliait sur 3 lignes serrées et
          le menu débordait hors de l'écran, "Admin" tronqué). On les empile
          donc, centrés, en dessous du seuil sm ; le menu passe à la ligne
          proprement (flex-wrap) au lieu de déborder. Au-delà de sm, on retrouve
          exactement l'ancienne disposition sur une seule ligne (date à gauche,
          menu à droite). En compact, tout est resserré (gap/texte plus
          petits) mais la structure empilée reste identique. */}
      <div
        className={`flex flex-col items-center uppercase sm:flex-row sm:justify-between sm:gap-0 ${
          compact ? "gap-0.5 py-0.5 text-[0.6rem] tracking-[0.15em]" : "gap-1.5 py-1.5 text-xs tracking-[0.2em]"
        }`}
      >
        <span className="capitalize">{formatted}</span>
        <nav
          className={`flex flex-wrap justify-center sm:flex-nowrap sm:gap-y-0 ${
            compact ? "gap-x-3 gap-y-0.5 sm:space-x-4" : "gap-x-5 gap-y-1 sm:space-x-6"
          }`}
        >
          <Link href="/direct" className="text-journal hover:underline">
            En direct
          </Link>
          <Link href="/archive" className="hover:underline">
            Archives
          </Link>
          <Link href="/favoris" className="hover:underline">
            Favoris
          </Link>
          <Link href="/admin/categories" className="text-sepia hover:underline">
            Admin
          </Link>
        </nav>
      </div>
      <div className="double-rule rotate-180" />
    </header>
  );
}
