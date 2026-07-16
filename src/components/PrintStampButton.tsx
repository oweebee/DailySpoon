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
    <div className="mb-10 flex flex-col items-center gap-3 border-b-2 border-ink/20 pb-8">
      <button
        onClick={print}
        disabled={printing}
        className="stamp-button border-2 border-ink bg-ink px-6 py-3 font-display text-xs uppercase tracking-[0.25em] text-paper transition-colors hover:bg-paper hover:text-ink disabled:opacity-50"
      >
        {printing ? "Impression en cours..." : "Lancer l'impression du journal"}
      </button>
      <p className="max-w-xs text-center text-[0.7rem] italic text-sepia">
        ⚠ Consomme des tokens de l’API {providerLabel} à chaque impression.
      </p>
      {message && <p className="text-sm italic text-sepia">{message}</p>}
    </div>
  );
}
