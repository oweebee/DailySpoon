"use client";

import { useLayoutEffect, useEffect, useRef, useState, type ReactNode } from "react";
import { Masthead } from "./Masthead";

// Durée du petit défilement animé joué à chaque swipe pour rejoindre la
// position cible de la nouvelle colonne (haut, ou position mémorisée) —
// volontairement très court : on veut un effet "rapide" perceptible, pas un
// scroll fluide lent façon smooth-scroll classique.
const SNAP_DURATION_MS = 180;

// Silence (sans aucun événement de défilement horizontal) au bout duquel on
// considère le swipe terminé et le scroll-snap posé. Assez long pour couvrir
// la fin de l'animation de snap du navigateur — sinon on conclurait trop tôt,
// en plein geste, ce qui est exactement le bug que ce délai corrige. Assez
// court pour rester imperceptible : le rattrapage vertical s'enchaîne juste
// après, sans temps mort ressenti.
const SETTLE_DELAY_MS = 140;

// Ease-IN-OUT : démarre doucement, accélère, PUIS ralentit à nouveau juste
// avant d'arriver pour se poser en douceur sur la position cible — plutôt
// qu'un ease-in pur qui finirait à pleine vitesse et s'arrêterait net (ce qui
// donne une impression de "freinage brutal" à l'oeil, pas un atterrissage
// propre).
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Anime le défilement de la fenêtre jusqu'à "target", en ~SNAP_DURATION_MS.
 * "cancelRef" permet d'interrompre proprement une animation en cours si une
 * nouvelle est déclenchée avant la fin (swipes rapides successifs).
 */
function animateScrollTo(target: number, cancelRef: { current: number | null }, onDone?: () => void) {
  if (cancelRef.current !== null) cancelAnimationFrame(cancelRef.current);

  const html = document.documentElement;

  // NE JAMAIS toucher à "overflow" de <html> ici. Une version précédente y
  // basculait brièvement "hidden" pour couper l'inertie de défilement iOS.
  // Effet de bord constaté en usage réel : cette fonction étant appelée au
  // changement de colonne, et le changement de colonne étant alors détecté
  // EN PLEIN GESTE, rendre le document non défilable ne serait-ce qu'un
  // reflow annulait le défilement tactile en cours — y compris le swipe
  // horizontal lui-même, qui restait bloqué entre deux colonnes. Le
  // déclenchement se fait désormais une fois le geste terminé (voir le
  // détecteur de colonne active plus bas), ce qui règle le problème
  // d'inertie à la source, sans rien forcer.
  const start = window.scrollY;
  const distance = target - start;
  if (Math.abs(distance) < 1) {
    onDone?.();
    return;
  }
  const startTime = performance.now();

  // Le "scroll anchoring" natif du navigateur (activé par défaut) essaie de
  // compenser tout seul les changements de taille de contenu au-dessus/dans
  // la zone visible (ex. une image qui finit de charger pendant qu'on
  // défile) en réajustant la position de défilement — ce qui vient
  // perturber/adoucir artificiellement la fin de NOTRE animation, donnant
  // l'impression d'un ralentissement juste avant l'arrivée alors que la
  // courbe d'accélération elle-même n'en produit aucun. On le désactive le
  // temps de l'animation, puis on le restaure.
  const previousAnchor = html.style.overflowAnchor;
  html.style.overflowAnchor = "none";

  function step(now: number) {
    const t = Math.min(1, (now - startTime) / SNAP_DURATION_MS);
    window.scrollTo(0, start + distance * easeInOutCubic(t));
    if (t < 1) {
      cancelRef.current = requestAnimationFrame(step);
    } else {
      cancelRef.current = null;
      html.style.overflowAnchor = previousAnchor;
      onDone?.();
    }
  }
  cancelRef.current = requestAnimationFrame(step);
}

/**
 * Carrousel mobile "une page = une rubrique" (dont "À la une"), swipe
 * horizontal natif (scroll-snap), où chaque page emporte avec elle sa PROPRE
 * copie du menu du haut (Masthead) — tout défile ensemble comme un seul
 * bloc, exactement comme si on changeait de page de site plutôt que de
 * simplement changer de colonne. Contrairement à l'ancienne version (zone de
 * défilement interne à hauteur fixe par page), il n'y a ici AUCUNE limite de
 * hauteur ni de défilement propre à chaque page : on descend normalement
 * dans la page du navigateur pour explorer tous les articles d'une rubrique.
 *
 * Problème résolu par ce composant : dans un conteneur flex en ligne
 * (défilement horizontal), toutes les pages seraient sinon étirées à la
 * hauteur de la plus grande d'entre elles (comportement par défaut du
 * cross-axis flex, "items-stretch") — d'où le "items-start" sur le
 * conteneur juste en dessous, INDISPENSABLE : sans lui, la mesure
 * scrollHeight de la page active (juste plus bas) renvoie la hauteur de sa
 * propre boîte déjà étirée à l'ancienne hauteur du conteneur, jamais sa
 * hauteur naturelle — le conteneur ne rétrécit alors plus jamais en
 * swipant vers une rubrique plus courte (bug vu en usage réel : swipe
 * depuis une colonne longue, scrollée bas, vers une colonne courte —
 * celle-ci restait étirée avec un grand vide sous son contenu, et le
 * rattrapage de défilement plus bas ne remontait jamais correctement en
 * haut). On fixe nous-mêmes la hauteur du conteneur à celle de la SEULE
 * page actuellement visible (mesurée via ResizeObserver, donc mise à jour
 * automatiquement si son contenu grandit — chargement infini compris).
 */
export function MobilePagedSection({
  date,
  pages,
  className = "",
  mastheadAction,
  titleAside,
  navExtra
}: {
  date: Date;
  pages: { key: string; content: ReactNode }[];
  className?: string;
  /** Timbre d'action affiché à droite du titre dans le Masthead (voir
   *  Masthead). Rendu une fois PAR PAGE du carrousel, comme le reste du
   *  bandeau — chaque copie est indépendante, ce qui est sans conséquence
   *  puisque l'action recharge la page. */
  mastheadAction?: ReactNode;
  /** Posé à droite du titre en compact (compte d'articles) — voir Masthead. */
  titleAside?: ReactNode;
  /** Élément posé à droite du menu (recherche) — voir Masthead. */
  navExtra?: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const activeIndexRef = useRef(0);
  const isFirstRender = useRef(true);
  const scrollAnimRef = useRef<number | null>(null);
  // Position de défilement (verticale, relative au haut du conteneur)
  // mémorisée par page — pas d'entrée = jamais visitée/jamais défilée, donc
  // on atterrit en haut ; une entrée existante restaure exactement l'endroit
  // où on était avant de swiper ailleurs.
  const scrollOffsets = useRef<Record<number, number>>({});
  // Vrai entre le moment où un swipe est détecté et celui où le défilement
  // vertical de rattrapage est réellement arrivé à destination — voir
  // l'enregistrement de position plus bas pour la raison précise. Ref (pas
  // un state) : lu de façon synchrone dans des handlers d'événements DOM,
  // pas besoin de re-render.
  const isTransitioningRef = useRef(false);

  // Synchro AVANT peinture (voir plus bas pourquoi) : sans ça, l'effet qui
  // enregistre la position de défilement pourrait encore lire l'ancien index
  // pendant les tout premiers frames de l'animation de la nouvelle colonne.
  useLayoutEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  // Détecte quelle page est affichée, UNE FOIS LE GESTE TERMINÉ et le
  // scroll-snap posé — jamais pendant que le doigt bouge encore.
  //
  // La version précédente réagissait à chaque événement de défilement :
  // Math.round(scrollLeft / width) bascule dès qu'on dépasse la moitié d'une
  // page, donc en plein geste. Tout ce qui suit ce changement d'index (recalage
  // de la hauteur du conteneur, défilement vertical de rattrapage) venait
  // alors se jouer PENDANT le swipe, avec deux conséquences observées en
  // usage réel :
  //   - le swipe restait bloqué entre deux colonnes, le geste tactile étant
  //     interrompu par ces manipulations ;
  //   - la hauteur du conteneur rétrécissait d'un coup vers celle de la
  //     colonne suivante, plus courte : le navigateur ramenait alors
  //     "scrollY" dans les nouvelles limites, et on se retrouvait au-delà de
  //     la fin de cette colonne, face à une zone vide.
  //
  // On attend donc l'arrêt complet du défilement horizontal (SETTLE_DELAY_MS
  // sans le moindre événement), ET une position posée pile sur une page
  // (tolérance de 2 px) — sinon on laisse le snap finir son travail.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    function commitActivePage() {
      const el = containerRef.current;
      if (!el) return;
      const width = el.clientWidth || 1;
      const index = Math.round(el.scrollLeft / width);
      // Snap pas encore terminé : on ne fait rien, un nouvel événement de
      // défilement relancera ce contrôle.
      if (Math.abs(el.scrollLeft - index * width) > 2) return;
      setActiveIndex((prev) => {
        if (prev === index) return prev;
        isTransitioningRef.current = true;
        return index;
      });
    }

    function onScroll() {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(commitActivePage, SETTLE_DELAY_MS);
    }

    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (settleTimer) clearTimeout(settleTimer);
    };
  }, []);

  // Enregistre en continu la position de défilement de la page ACTUELLEMENT
  // active (indépendant du swipe horizontal, qui ne touche pas au défilement
  // vertical de la fenêtre) — sert à la restaurer si on revient sur cette
  // page plus tard.
  //
  // Ignoré tant qu'une transition est en cours (isTransitioningRef) : entre
  // le swipe et l'atterrissage définitif, "window.scrollY" bouge pour des
  // raisons qui n'ont RIEN à voir avec une lecture réelle de l'utilisateur —
  // notamment le clamp automatique du navigateur quand le conteneur rétrécit
  // (voir l'effet de hauteur juste en dessous, colonne plus courte que
  // l'ancienne : le navigateur recale scrollY tout seul dès que le document
  // devient plus court que la position actuelle) et notre propre défilement
  // de rattrapage. Sans cette garde, l'un de ces mouvements "fantômes" —
  // jamais voulus par l'utilisateur — pouvait s'enregistrer comme position
  // de lecture d'une colonne pourtant jamais vraiment visitée, et le swipe
  // suivant vers cette même colonne restaurait alors ce décalage bidon au
  // lieu de remonter en haut (bug vu en usage réel : marchait au début,
  // cassait de façon aléatoire après quelques colonnes visitées).
  useEffect(() => {
    function onWindowScroll() {
      if (isTransitioningRef.current) return;
      const container = containerRef.current;
      if (!container) return;
      scrollOffsets.current[activeIndexRef.current] = Math.max(0, window.scrollY - container.offsetTop);
    }
    window.addEventListener("scroll", onWindowScroll, { passive: true });
    return () => window.removeEventListener("scroll", onWindowScroll);
  }, []);

  // Cale la hauteur du conteneur sur celle de la page active, et la
  // réajuste en continu (ResizeObserver) tant que son contenu change de
  // taille — notamment le défilement infini des colonnes, qui charge des
  // articles au fur et à mesure qu'on approche du bas. Doit s'exécuter avant
  // la restauration de position ci-dessous, sinon le conteneur peut ne pas
  // encore être assez haut pour atteindre la position mémorisée.
  useLayoutEffect(() => {
    const el = pageRefs.current[activeIndex];
    const container = containerRef.current;
    if (!el || !container) return;
    const sync = () => {
      container.style.height = `${el.scrollHeight}px`;
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeIndex, pages.length]);

  // À chaque changement de page : on reste d'abord exactement où on était
  // (même niveau de défilement que la colonne quittée, pas de saut immédiat),
  // puis un petit défilement animé et rapide rejoint la position cible de la
  // nouvelle colonne — son sommet si jamais défilée, ou sa position exacte
  // mémorisée sinon. On ignore le tout premier rendu (arrivée sur la page),
  // pour ne pas animer quoi que ce soit au chargement.
  //
  // isTransitioningRef repasse à false seulement une fois VRAIMENT arrivé
  // (onDone du rattrapage), pas avant — un nouveau swipe déclenché avant la
  // fin relance simplement une nouvelle animation sans jamais repasser par
  // false entre les deux, donc l'enregistrement de position reste bien
  // suspendu pendant toute la chaîne de swipes rapides successifs.
  useLayoutEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    const offset = scrollOffsets.current[activeIndex] ?? 0;
    animateScrollTo(container.offsetTop + offset, scrollAnimRef, () => {
      isTransitioningRef.current = false;
    });
  }, [activeIndex]);

  useEffect(() => {
    return () => {
      if (scrollAnimRef.current !== null) cancelAnimationFrame(scrollAnimRef.current);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={`-mx-6 flex items-start snap-x snap-mandatory overflow-x-auto ${className}`}
    >
      {pages.map((page, i) => (
        <div
          key={page.key}
          ref={(el) => {
            pageRefs.current[i] = el;
          }}
          className="w-full shrink-0 snap-center px-6"
        >
          <Masthead date={date} compact action={mastheadAction} titleAside={titleAside} navExtra={navExtra} />
          {page.content}
        </div>
      ))}
    </div>
  );
}
