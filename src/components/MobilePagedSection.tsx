"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Masthead } from "./Masthead";

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
  // Position de défilement (verticale, relative au haut du conteneur)
  // mémorisée par page — pas d'entrée = jamais visitée/jamais défilée, donc
  // on atterrit en haut ; une entrée existante restaure exactement l'endroit
  // où on était avant de swiper ailleurs.
  const scrollOffsets = useRef<Record<number, number>>({});

  useEffect(() => {
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
  // page plus tard.
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
  useEffect(() => {
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

  // À chaque changement de page : remonte en haut si cette colonne n'a
  // jamais été défilée, ou restaure sa position exacte si on y était déjà
  // allé et qu'on y avait défilé. On ignore le tout premier rendu (arrivée
  // sur la page), pour ne pas faire sauter la fenêtre au chargement.
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    const offset = scrollOffsets.current[activeIndex] ?? 0;
    window.scrollTo({ top: container.offsetTop + offset, behavior: "auto" });
  }, [activeIndex]);

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
