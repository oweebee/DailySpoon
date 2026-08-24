import Link from "next/link";
import type { ReactNode } from "react";

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
  compact = false,
  action,
  hideLiveStamp = false
}: {
  date: Date;
  /** Version resserrée verticalement, utilisée uniquement pour la copie
   *  dupliquée en haut de chaque page du carrousel mobile (voir
   *  MobilePagedSection) — répétée à chaque swipe, elle repoussait le début
   *  des articles à plus de la moitié de l'écran sur téléphone. Le Masthead
   *  "normal" (desktop, une seule copie fixe) n'est pas concerné. */
  compact?: boolean;
  /** Timbre d'action propre à la page, calé à DROITE sur la ligne du titre :
   *  "Lancer l'impression du journal" sur l'accueil, "Télégraphier les
   *  nouvelles" sur /direct. Auparavant en gros bloc centré au-dessus du
   *  bandeau, ce qui repoussait le début des articles très bas — surtout en
   *  mobile, où ce bandeau est en plus dupliqué à chaque colonne. */
  action?: ReactNode;
  /** Masque le timbre "En direct". Utilisé sur /direct même : y proposer un
   *  raccourci vers la page où l'on se trouve déjà n'a aucun intérêt, et ça
   *  libère la place pour le timbre d'action. */
  hideLiveStamp?: boolean;
}) {
  const formatted = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(date);

  return (
    <header className={compact ? "mb-3" : "mb-10"}>
      {/* Bloc "tête de journal" : bandeau du haut, ligne du titre, double
          filet. Plus aucun positionnement absolu ici depuis que les timbres
          vivent dans la ligne du titre elle-même (voir plus bas). */}
      <div>
        {/* Filet supérieur seul : les mentions "Édition quotidienne
            personnelle" / "Prix : ≈ 10 ¢" qui l'accompagnaient ont été
            retirées (purement décoratives, elles coûtaient une ligne de
            hauteur sur chaque copie du bandeau — et le carrousel mobile en
            affiche une par colonne). Le trait, lui, reste : c'est lui qui
            ferme le haut de la tête de journal. */}
        <div className="border-b border-ink" />

        {/* Ligne du titre : nom du journal calé à GAUCHE, timbres calés à
            DROITE (le "En direct" puis, s'il y en a un, le timbre d'action de
            la page). Une seule et même disposition en mobile comme en
            desktop — d'où la disparition des deux variantes de timbre "En
            direct" qui coexistaient ici (une centrée sous le titre en
            mobile, une en position absolue à droite en desktop) : dans une
            ligne flex, le timbre se place naturellement à droite aux deux
            tailles, seule sa hauteur change.

            Les timbres tirent leur LARGEUR de leur hauteur via aspect-ratio
            (voir .stamp-bg-* dans globals.css) : on ne fixe donc jamais que
            la hauteur, et l'image n'est jamais déformée. "shrink-0" sur le
            groupe de droite pour que ce soit le titre qui cède de la place
            si l'écran est vraiment étroit, jamais les timbres. */}
        <div className={`flex items-center justify-between gap-3 ${compact ? "py-2" : "py-5"}`}>
          <Link
            href="/"
            // Titre légèrement réduit en compact : il partage la ligne avec
            // DEUX timbres désormais plus grands, et sur un écran de
            // téléphone étroit c'est lui qui, sinon, se replie sur deux
            // lignes (les timbres, eux, sont en shrink-0).
            className={`font-masthead font-black uppercase leading-none tracking-tight ${
              compact ? "text-xl" : "text-4xl md:text-6xl"
            }`}
          >
            DailySp
            <SpoonO />
            <SpoonO />n
          </Link>

          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            {/* Timbre "EN DIRECT" — classe ".stamp-live" autonome (voir
                globals.css), qui NE se combine PAS avec ".stamp-button" :
                les deux se disputaient la propriété "transform" (rotation vs
                centrage), et la rotation ne s'affichait alors jamais. Le
                fond reste droit ; seul le texte, enveloppé dans
                .stamp-live-text, garde l'inclinaison. */}
            {!hideLiveStamp && (
              <Link
                href="/direct"
                // Hauteur ET largeur fixées explicitement, dans le ratio EXACT
                // de l'image de fond (stamp-bg-sm = 600/406). C'est ce qui
                // permet d'aligner ce timbre sur le timbre d'action voisin :
                // les deux partagent la même hauteur à chaque palier, alors
                // que leurs images ont des proportions très différentes (ce
                // dernier est bien plus large que haut). En ne fixant que la
                // hauteur, la largeur d'un élément flex se calcule sur son
                // CONTENU et non sur le ratio — d'où un timbre déformé ou du
                // texte qui déborde.
                //
                // Pas de padding horizontal, et "whitespace-nowrap" : cette
                // largeur ne s'adapte pas au texte, donc le moindre px-*
                // faisait replier "EN DIRECT" sur deux lignes.
                className={`stamp-live stamp-bg-sm flex shrink-0 items-center justify-center font-display uppercase leading-none text-white ${
                  compact
                    ? "h-[2rem] w-[2.95rem] text-[0.48rem] tracking-[0.04em]"
                    : "h-[2.75rem] w-[4.05rem] text-[0.6rem] tracking-[0.06em] md:h-[3.25rem] md:w-[4.8rem] md:text-[0.7rem] md:tracking-[0.07em]"
                }`}
              >
                <span className="stamp-live-text whitespace-nowrap">En direct</span>
              </Link>
            )}
            {action}
          </div>
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
