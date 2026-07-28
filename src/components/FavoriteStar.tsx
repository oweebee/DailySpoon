"use client";

import { useState } from "react";

/**
 * Étoile "shérif" (pointes à bout rond, façon étoile de badge) pour marquer
 * un article en favori. Bascule optimiste + persistance immédiate en base
 * via /api/articles/favorite.
 */
export function FavoriteStar({
  articleId,
  initialFavorite,
  onToggle
}: {
  articleId: string;
  initialFavorite: boolean;
  /** Appelé après un basculement réussi (ex. retirer la ligne de /favoris
   *  dès que l'étoile est décochée, sans attendre un rechargement). */
  onToggle?: (next: boolean) => void;
}) {
  const [favorite, setFavorite] = useState(initialFavorite);
  const [pending, setPending] = useState(false);

  async function toggle() {
    const next = !favorite;
    setFavorite(next);
    setPending(true);
    try {
      await fetch("/api/articles/favorite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ articleId, favorite: next })
      });
      onToggle?.(next);
    } catch {
      // Best-effort : on laisse l'état optimiste tel quel, une prochaine
      // visite resynchronisera depuis la base si la requête a échoué.
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      title={favorite ? "Retirer des favoris" : "Ajouter aux favoris"}
      aria-pressed={favorite}
      className="inline-flex shrink-0 items-center align-middle disabled:opacity-50"
    >
      <SheriffStar filled={favorite} />
    </button>
  );
}

function SheriffStar({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      className={filled ? "text-[#8a0303]" : "text-sepia/50 hover:text-sepia"}
    >
      <path
        d="M12,2 L14.35,8.76 L21.51,8.91 L15.80,13.24 L17.88,20.09 L12,16 L6.12,20.09 L8.20,13.24 L2.49,8.91 L9.65,8.76 Z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      {/* Pointes à bout rond façon étoile de shérif */}
      {[
        [12, 2],
        [21.51, 8.91],
        [17.88, 20.09],
        [6.12, 20.09],
        [2.49, 8.91]
      ].map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.5" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.1" />
      ))}
    </svg>
  );
}
