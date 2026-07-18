"use client";

import { useState, type MouseEvent } from "react";
import { useRouter } from "next/navigation";

/**
 * Bouton "Supprimer" pour une édition archivée (/archive et /archive/[id]).
 * Suppression DÉFINITIVE en base (voir /api/admin/editions, DELETE) — sans
 * risque pour les vrais articles vivants (En direct/recherche/favoris) :
 * seule la "photo figée" de cette impression précise disparaît, voir le
 * commentaire de la route pour le détail des contraintes FK.
 */
export function DeleteEditionButton({
  editionId,
  label,
  // Si fourni, redirige vers cette URL après suppression (utilisé sur la
  // page détail d'une édition, qui n'a plus de raison d'exister une fois
  // l'édition supprimée) — sinon rafraîchit simplement la page courante
  // (utilisé dans la liste /archive, où seule cette ligne doit disparaître).
  redirectTo
}: {
  editionId: string;
  label: string;
  redirectTo?: string;
}) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  async function handleDelete(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm(`Supprimer définitivement l'édition du ${label} ? Cette action est irréversible.`)) return;

    setDeleting(true);
    const res = await fetch("/api/admin/editions", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: editionId })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      window.alert(body.error || "Échec de la suppression.");
      setDeleting(false);
      return;
    }
    if (redirectTo) {
      router.push(redirectTo);
    } else {
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      onClick={handleDelete}
      disabled={deleting}
      className="shrink-0 text-xs uppercase tracking-[0.2em] text-journal hover:underline disabled:opacity-50"
    >
      {deleting ? "Suppression..." : "Supprimer"}
    </button>
  );
}
