"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Bouton "timbre" pour déclencher manuellement l'impression de l'édition
 * (génération IA complète, même chemin que le worker) — affiché sur
 * l'accueil uniquement quand le planning automatique est désactivé dans
 * /admin/settings (sinon le worker s'en charge tout seul, pas besoin de
 * bouton). L'avertissement sur la conso de tokens reste inline, dans le
 * thème (italique, sépia) — pas de popup.
 */
export function PrintStampButton({ provider }: { provider?: string }) {
  const router = useRouter();
  const providerLabel = provider === "gemini" ? "Gemini" : "Anthropic";
  const [printing, setPrinting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function print() {
    // Popup de confirmation natif (fonctionne aussi bien sur mobile que sur
    // desktop, sans dépendance ni composant modal maison) : évite qu'un clic
    // accidentel (ou un doigt qui glisse sur mobile) ne déclenche une
    // impression IA — donc une consommation de tokens — sans confirmation
    // explicite. Ce bouton n'est de toute façon affiché que quand le
    // planning automatique est désactivé (voir page.tsx) : en mode manuel,
    // AUCUNE impression IA ne doit pouvoir partir sans cette validation.
    const confirmed = window.confirm(
      `Lancer l'impression du journal ? Cette action va consommer des tokens de l'API ${providerLabel}.`
    );
    if (!confirmed) return;

    setPrinting(true);
    setMessage(null);
    try {
      const res = await fetch("/api/cron/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setMessage(`Édition imprimée — ${body.articleCount} article(s).`);
        router.refresh();
      } else {
        setMessage(body.error || "Échec de l'impression.");
      }
    } catch {
      setMessage("Échec de l'impression.");
    } finally {
      setPrinting(false);
    }
  }

  return (
    // Timbre compact, calé à droite du titre dans le bandeau (voir Masthead,
    // prop "action") — plus l'ancien gros bloc centré pleine largeur posé
    // au-dessus du bandeau, qui repoussait le début des articles très bas,
    // surtout en mobile où ce bandeau est dupliqué à chaque colonne.
    //
    // Largeur fixe : le fond de timbre (stamp-bg-lg) tire sa HAUTEUR de la
    // largeur via aspect-ratio (voir globals.css), donc c'est la largeur
    // qu'on pilote, jamais la hauteur. Texte sur 2 lignes volontaires
    // ("Lancer l'impression" / "du journal") pour rester lisible une fois
    // réduit à cette taille.
    <span className="inline-flex flex-col items-center">
      <button
        onClick={print}
        disabled={printing}
        className="stamp-button stamp-bg-lg flex w-[9.5rem] flex-col items-center justify-center px-3 font-display text-[0.5rem] uppercase leading-tight tracking-[0.15em] text-paper disabled:opacity-50 sm:w-[13rem] sm:px-5 sm:text-[0.65rem] sm:tracking-[0.2em]"
      >
        {printing ? (
          <>
            <span>Impression</span>
            <span>en cours...</span>
          </>
        ) : (
          <>
            <span>Lancer l’impression</span>
            <span>du journal</span>
          </>
        )}
      </button>
      {/* Avertissement conso de tokens : conservé (c'est la règle n°1 du
          projet de rester conscient du coût IA) mais réduit sous le timbre
          plutôt qu'en paragraphe centré pleine largeur. */}
      <span className="mt-1 max-w-[9.5rem] text-center text-[0.55rem] italic leading-tight text-sepia sm:max-w-[13rem] sm:text-[0.6rem]">
        ⚠ Consomme des tokens {providerLabel}
      </span>
      {message && (
        <span className="mt-0.5 text-center text-[0.6rem] italic text-sepia">{message}</span>
      )}
    </span>
  );
}
