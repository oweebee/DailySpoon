"use client";

import { useEffect, useRef, useState } from "react";
import type { ArticleLike } from "./EditionView";
import { SourceLine, formatStamp, directTitle, directText, directHref } from "./EditionView";
import { ArticleImage } from "./ArticleImage";
import { ArticleLink } from "./ArticleLink";

const INITIAL_COUNT = 5;
const STEP = 5;

export function CategoryColumn({
  label,
  articles,
  draggable = false,
  isDragging = false,
  onDragStart,
  onDragEnd,
  onDropHere,
  clampSummary = false,
  showMedal = true,
  showDateStamp = true,
  showFavorite = true,
  scrollExpand = false,
  autoInfinite = false
}: {
  label: string;
  articles: ArticleLike[];
  /** Autorise le glisser-déposer du titre pour réorganiser les colonnes.
   *  Désactivé si cette catégorie n'a pas d'équivalent dans les réglages
   *  admin (ex. rubrique éditoriale choisie par l'IA) — rien à persister. */
  draggable?: boolean;
  isDragging?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDropHere?: () => void;
  /** Limite l'aperçu à 10 lignes (page "En direct") — pour lire la suite,
   *  on ouvre l'article via la photo ou le lien source. */
  clampSummary?: boolean;
  /** La page d'accueil (FrontPageView) n'a pas la notion de médaille, de
   *  tampon-date sur la photo (toujours l'édition du jour) ni de favoris —
   *  ces trois options permettent de les masquer, tout en gardant le
   *  comportement habituel (true) partout ailleurs (/direct, colonnes
   *  classiques). */
  showMedal?: boolean;
  showDateStamp?: boolean;
  showFavorite?: boolean;
  /** Version bureau : au lieu de faire grandir la colonne (et donc pousser
   *  toute la mise en page) à chaque clic sur "afficher plus", on bascule la
   *  liste dans un encart à hauteur figée (celle qu'elle avait juste avant
   *  le clic) avec sa propre barre de défilement interne. Les articles
   *  suivants se révèlent au fur et à mesure du défilement à l'intérieur de
   *  cet encart, jusqu'à épuisement de l'historique déjà chargé — la
   *  colonne elle-même ne bouge plus jamais. Désactivé sur mobile (voir
   *  autoInfinite). */
  scrollExpand?: boolean;
  /** Version mobile : pas de bouton du tout — les rubriques sont empilées
   *  verticalement dans le flux normal de la page (voir CategoryGrid), donc
   *  on charge directement le lot suivant dès qu'on approche du bas de la
   *  liste déjà affichée en faisant défiler la page entière, sans jamais
   *  demander de clic. root=null observe directement la fenêtre plutôt qu'un
   *  conteneur à hauteur fixe. Mutuellement exclusif avec scrollExpand
   *  (desktop). */
  autoInfinite?: boolean;
}) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_COUNT);
  const [expanded, setExpanded] = useState(false);
  const [lockedHeight, setLockedHeight] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const visible = articles.slice(0, visibleCount);
  const remaining = articles.length - visible.length;

  function handleShowMore() {
    if (scrollExpand) {
      // On fige la hauteur actuelle de l'encart avant de passer en mode
      // défilement interne, pour que la colonne (et donc la page) ne bouge
      // pas d'un pixel au clic.
      if (listRef.current) setLockedHeight(listRef.current.getBoundingClientRect().height);
      setExpanded(true);
    }
    setVisibleCount((c) => Math.min(c + STEP, articles.length));
  }

  // Défilement "à l'infini" : soit à l'intérieur de l'encart figé (desktop,
  // une fois "expanded" après clic), soit directement sur le défilement de
  // la page (mobile, autoInfinite, dès le départ — pas de clic requis). Dans
  // le 2nd cas, root=null observe la fenêtre elle-même plutôt qu'un
  // conteneur à hauteur fixe.
  const watching = (scrollExpand && expanded) || autoInfinite;
  useEffect(() => {
    if (!watching) return;
    const sentinel = sentinelRef.current;
    const root = scrollExpand ? listRef.current : null;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((c) => Math.min(c + STEP, articles.length));
        }
      },
      // 1200 px d'avance et non 400 : une carte d'article fait déjà 400 à
      // 500 px de haut sur un téléphone (photo 16/9 + une dizaine de lignes),
      // donc à 400 px le lot suivant ne partait qu'une fois la fin de liste
      // pratiquement atteinte — on voyait le "Chargement de la suite…" puis
      // le contenu apparaître d'un bloc. Trois cartes d'avance suffisent à ce
      // que la suite soit toujours déjà là quand on y arrive.
      { root, rootMargin: "1200px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [watching, scrollExpand, articles.length]);

  return (
    // Le filet/padding séparant les colonnes visuelles est désormais posé sur
    // le conteneur de colonne dans CategoryGrid (une colonne = un bloc
    // flex-col indépendant empilant SES catégories, plus une grille CSS où
    // toutes les catégories d'une même "rangée" seraient forcées à la même
    // hauteur) — plus besoin ici de calculer un filet par position
    // (nth-child) dans une grille plate.
    <section
      onDragOver={draggable ? (e) => e.preventDefault() : undefined}
      onDrop={
        draggable
          ? (e) => {
              e.preventDefault();
              onDropHere?.();
            }
          : undefined
      }
      className={isDragging ? "opacity-40" : ""}
    >
      {/* Titre de rubrique : un court trait d'accent, le nom, puis un filet
          qui s'efface vers la droite. Remplace l'ancien bandeau plein aux
          angles arrondis, qui posait un gros pavé opaque en travers de la
          colonne à chaque rubrique — beaucoup de poids visuel pour deux mots.
          Ici le nom se lit d'abord, le trait de couleur sert de repère, et le
          filet dégradé prolonge la ligne sans la fermer. */}
      <h2
        draggable={draggable}
        onDragStart={draggable ? onDragStart : undefined}
        onDragEnd={draggable ? onDragEnd : undefined}
        className={`mb-4 flex items-center gap-3 ${
          draggable ? "cursor-grab select-none active:cursor-grabbing" : ""
        }`}
      >
        <span aria-hidden="true" className="h-4 w-[3px] shrink-0 rounded-full bg-journal" />
        <span className="whitespace-nowrap font-display text-sm font-bold uppercase tracking-[0.3em] text-ink">
          {label}
        </span>
        {/* Filet dégradé plutôt qu'un trait net : il s'éteint avant le bord de
            la colonne, donc il accompagne le titre au lieu de le souligner
            d'un bout à l'autre. "min-w-0" pour qu'il cède la place au nom
            quand la colonne est étroite (mobile), jamais l'inverse. */}
        <span aria-hidden="true" className="h-px min-w-0 flex-1 bg-gradient-to-r from-ink/30 to-transparent" />
      </h2>
      <div
        ref={listRef}
        style={expanded && lockedHeight ? { maxHeight: lockedHeight, overflowY: "auto" } : undefined}
        className={`flex flex-col gap-4 ${expanded ? "pr-4" : ""}`}
      >
        {visible.map((article) => (
          // Chaque article dans son propre encadré (bordure + fond gris) —
          // même teinte que les encadrés de rubrique de la page IA
          // (CATEGORY_BOX_TONES dans FrontPageView, bg-ink/[0.07]). Remplace
          // l'ancien filet horizontal (divide-y) entre articles.
          // "article-card" : simple point d'accroche pour le thème (voir
          // globals.css). En Material, le fond gris est conservé — c'est lui
          // qui délimite la carte — mais le trait de contour disparaît.
          <article key={article.id} className="article-card border-2 border-ink bg-ink/[0.07] p-4">
            {article.imageUrl && (
              <ArticleLink
                href={directHref(article)}
                title={directTitle(article)}
                className="mb-2 block aspect-[16/9] w-full"
              >
                <ArticleImage
                  src={article.imageUrl}
                  alt={directTitle(article)}
                  dateLabel={showDateStamp ? formatStamp(article.publishedAt) : null}
                  medal={showMedal ? article.medal : false}
                  className="h-full w-full"
                />
              </ArticleLink>
            )}
            <h3 className="font-display text-sm font-bold leading-snug">{directTitle(article)}</h3>
            <p
              className={`mt-1 text-sm leading-snug text-neutral-700 ${
                clampSummary ? "line-clamp-[10]" : ""
              }`}
            >
              {directText(article)}
            </p>
            <SourceLine article={article} showDate={!article.imageUrl} showFavorite={showFavorite} />
          </article>
        ))}
        {(expanded || autoInfinite) && remaining > 0 && (
          <div ref={sentinelRef} className="py-3 text-center text-[0.6rem] italic uppercase tracking-[0.2em] text-sepia/70">
            Chargement de la suite…
          </div>
        )}
      </div>

      {!expanded && !autoInfinite && remaining > 0 && (
        // Le bouton clôt sa rubrique, un filet la referme avant la suivante.
        // Ce filet s'éteint à ses deux extrémités (dégradé) au lieu d'être un
        // pointillé net d'un bord à l'autre : le pointillé faisait "bordure de
        // tableau" juste sous un bouton lui-même encadré, deux traits durs
        // empilés à 12 px d'intervalle.
        <div className="mt-3">
          <button
            onClick={handleShowMore}
            // Vrai bouton encadré, sur TOUTE la largeur de la colonne — donc
            // exactement la largeur d'une carte d'article, qu'il vient
            // prolonger en bas de pile. Remplace l'ancien libellé souligné en
            // pointillés, qui ne se lisait pas comme un élément cliquable.
            //
            // Bordure en "rule" et non en "ink" : dans le thème journal les
            // deux sont identiques (le cadre se confond donc avec celui des
            // cartes), tandis qu'en Material "ink" est CLAIR — un cadre de
            // 2 px en texte clair aurait hurlé au milieu de la colonne, alors
            // que "rule" y est le gris discret des séparateurs.
            //
            // py-2 : hauteur calée sur le texte, sans marge superflue.
            className="w-full border-2 border-rule bg-ink/[0.05] px-4 py-2 text-center text-[0.65rem] italic uppercase tracking-[0.2em] text-sepia hover:bg-ink/[0.1] hover:text-ink"
          >
            {scrollExpand
              ? "Afficher plus d'articles"
              : `Suite — encore ${Math.min(STEP, remaining)} de plus (${remaining} au total)`}
          </button>
          <div
            aria-hidden="true"
            className="mt-3 h-px bg-gradient-to-r from-transparent via-ink/25 to-transparent"
          />
        </div>
      )}
    </section>
  );
}
