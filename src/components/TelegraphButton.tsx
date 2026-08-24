"use client";

import { useState } from "react";

/**
 * Timbre "Télégraphier les nouvelles" de la page /direct : déclenche une
 * aspiration des flux SANS IA (règle du projet : /direct est un aperçu
 * rapide, jamais d'IA, même si une clé est configurée pour l'édition
 * quotidienne — voir noAi ci-dessous).
 *
 * Composant autonome (et non plus un bloc interne à DirectView) parce qu'il
 * s'affiche désormais DANS le bandeau du haut (Masthead), calé à droite du
 * titre : ce bandeau est rendu à deux endroits sans rapport l'un avec
 * l'autre — une fois par la page Next.js pour le desktop, et une fois PAR
 * COLONNE dans le carrousel mobile (voir MobilePagedSection) — dont l'un est
 * un composant serveur. Un bouton avec son propre état ne pouvait donc pas
 * rester enfermé dans DirectView ; chaque copie affichée gère simplement son
 * propre état d'envoi, ce qui est sans conséquence puisque l'action se
 * termine par un rechargement complet de la page.
 */
export function TelegraphButton({ className = "" }: { className?: string }) {
  const [pulling, setPulling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function pull() {
    setPulling(true);
    setMessage(null);
    const res = await fetch("/api/cron/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ noAi: true })
    });
    const body = await res.json().catch(() => ({}));
    setPulling(false);
    if (res.ok) {
      setMessage(`${body.articleCount} article${body.articleCount > 1 ? "s" : ""} — édition mise à jour.`);
      setTimeout(() => window.location.reload(), 900);
    } else {
      setMessage(body.error || "Échec de la récupération.");
    }
  }

  return (
    <span className={`inline-flex flex-col items-center ${className}`}>
      <button
        onClick={pull}
        disabled={pulling}
        // Largeur fixe (et non un simple padding) : le fond de timbre
        // (stamp-bg-lg) tire sa HAUTEUR de la largeur du bouton via
        // aspect-ratio (voir globals.css) — sans largeur imposée, un texte
        // replié sur 2 lignes réduirait la largeur naturelle et écraserait
        // donc aussi la hauteur, trop juste pour ces 2 lignes.
        className="stamp-button stamp-bg-lg flex w-[9.5rem] flex-col items-center justify-center px-3 font-display text-[0.5rem] uppercase leading-tight tracking-[0.15em] text-paper disabled:opacity-50 sm:w-[13rem] sm:px-5 sm:text-[0.65rem] sm:tracking-[0.2em]"
      >
        {pulling ? (
          <>
            <span>Télégraphie</span>
            <span>en cours...</span>
          </>
        ) : (
          <>
            <span>Télégraphier</span>
            <span>les nouvelles</span>
          </>
        )}
      </button>
      {/* Message de retour en position absolue-like (flux normal mais texte
          minuscule) : il ne doit pas décaler la ligne du titre quand il
          apparaît. */}
      {message && <span className="mt-1 text-center text-[0.6rem] italic text-sepia">{message}</span>}
    </span>
  );
}
