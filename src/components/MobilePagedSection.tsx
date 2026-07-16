"use client";

import { useLayoutEffect, useEffect, useRef, useState, type ReactNode } from "react";
import { Masthead } from "./Masthead";

// Durée du petit défilement animé joué à chaque swipe pour rejoindre la
// position cible de la nouvelle colonne (haut, ou position mémorisée) —
// volontairement très court : on veut un effet "rapide" perceptible, pas un
// scroll fluide lent façon smooth-scroll classique.
const SNAP_DURATION_MS = 180;

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Anime le défilement de la fenêtre jusqu'à "target", en ~SNAP_DURATION_MS.
 * "cancelRef" permet d'interrompre proprement une animation en cours si une
 * nouvelle est déclenchée avant la fin (swipes rapides successifs).
 */
function animateScrollTo(target: number, cancelRef: { current: number | null }) {
  if (cancelRef.current !== null) cancelAnimationFrame(cancelRef.current);
  const start = window.scrollY;
  const distance = target - start;
  if (Math.abs(distance) < 1) return;
  const startTime = performance.now();

  function step(now: number) {
    const t = Math.min(1, (now - startTime) / SNAP_DURATION_MS);
    window.scrollTo(0, start + distance * easeOutCubic(t));
    cancelRef.current = t < 1 ? requestAnimationFrame(step) : null;
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
 * cross-axis flex), laissant un grand vide sous les rubriques plus courtes.
 * On contourne ça en fixant nous-mêmes la hauteur du conteneur à celle de la
 * SEULE page actuellement visible (mesurée via ResizeObserver, donc mise à
 * jour automatiquement si son contenu grandit — chargement infini compris).
 */
export function MobilePagedSection({
  date,
  pages,
  className = ""
}: {
  date: Date;
  pages: { key: string; content: ReactNode }[];
  className?: string;
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

  // Synchro AVANT peinture (voir plus bas pourquoi) : sans ça, l'effet qui
  // enregistre la position de défilement pourrait encore lire l'ancien index
  // pendant les tout premiers frames de l'animation de la nouvelle colonne.
  useLayoutEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  // Détecte quelle page est actuellement affichée après un swipe.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    function onScroll() {
      const width = container!.clientWidth || 1;
      const index = Math.round(container!.scrollLeft / width);
      setActiveIndex((prev) => (prev === index ? prev : index));
    }
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, []);

  // Enregistre en continu la position de défilement de la page ACTUELLEMENT
  // active (indépendant du swipe horizontal, qui ne touche pas au défilement
  // vertical de la fenêtre) — sert à la restaurer si on revient sur cette
  // page plus tard. Se déclenche aussi pendant notre propre animation de
  // rattrapage ci-dessous, ce qui est voulu : la valeur enregistrée converge
  // naturellement vers la position cible au fil de l'animation.
  useEffect(() => {
    function onWindowScroll() {
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
  useLayoutEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    const offset = scrollOffsets.current[activeIndex] ?? 0;
    animateScrollTo(container.offsetTop + offset, scrollAnimRef);
  }, [activeIndex]);

  useEffect(() => {
    return () => {
      if (scrollAnimRef.current !== null) cancelAnimationFrame(scrollAnimRef.current);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={`-mx-6 flex snap-x snap-mandatory overflow-x-auto ${className}`}
    >
      {pages.map((page, i) => (
        <div
          key={page.key}
          ref={(el) => {
            pageRefs.current[i] = el;
          }}
          className="w-full shrink-0 snap-center px-6"
        >
          <Masthead date={date} />
          {page.content}
        </div>
      ))}
    </div>
  );
}
