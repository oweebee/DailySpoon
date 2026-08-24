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
        // Hauteurs identiques à celles du timbre "En direct" voisin (voir
        // Masthead) à chaque palier, et largeurs déduites du ratio EXACT de
        // l'image de fond (stamp-bg-lg = 900/205) : c'est ce qui aligne
        // proprement les deux timbres sur la ligne du titre, malgré des
        // proportions d'image très différentes.
        //
        // px-* et tailles de police prudentes pour la même raison que le
        // timbre "En direct" : l'image a un cadre perforé décoratif sur tout
        // son pourtour, sur lequel le texte ne doit jamais mordre. On laisse
        // donc une marge large plutôt que de viser au plus juste.
        className="stamp-button stamp-bg-lg flex h-[2rem] w-[8.8rem] flex-col items-center justify-center px-3 font-display text-[0.42rem] uppercase leading-none tracking-[0.08em] text-paper disabled:opacity-50 sm:h-[2.75rem] sm:w-[12.1rem] sm:px-4 sm:text-[0.55rem] sm:tracking-[0.1em] md:h-[3.25rem] md:w-[14.25rem] md:px-5 md:text-[0.65rem] md:tracking-[0.1em]"
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
