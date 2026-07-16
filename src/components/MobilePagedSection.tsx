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
  const isFirstRender = useRef(true);

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

  // Remonte en haut de la nouvelle colonne à chaque changement de page : le
  // swipe est horizontal mais le défilement vertical est maintenant celui de
  // la fenêtre (plus de zone de défilement interne par page), donc rien ne
  // ramenait automatiquement en haut de la rubrique fraîchement swipée si on
  // avait déjà défilé dans la précédente. On ignore le tout premier rendu
  // (arrivée sur la page), pour ne pas faire sauter la fenêtre au chargement.
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    containerRef.current?.scrollIntoView({ block: "start", inline: "nearest" });
  }, [activeIndex]);

  // Cale la hauteur du conteneur sur celle de la page active, et la
  // réajuste en continu (ResizeObserver) tant que son contenu change de
  // taille — notamment le défilement infini des colonnes, qui charge des
  // articles au fur et à mesure qu'on approche du bas.
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
