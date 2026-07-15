"use client";

import { useState } from "react";
import { EditionView, type ArticleLike } from "./EditionView";

export function DirectView({ initialArticles }: { initialArticles: ArticleLike[] }) {
  const [pulling, setPulling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function pull() {
    setPulling(true);
    setMessage(null);
    // Règle du projet : /direct est un aperçu rapide, jamais d'IA, même si une
    // clé Anthropic est configurée pour l'édition quotidienne (économie de tokens).
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
    <div>
      <div className="mb-10 flex flex-col items-center gap-3 border-b-2 border-ink pb-8 text-center">
        <p className="text-xs uppercase tracking-[0.35em] text-journal">✦ En direct ✦</p>
        <p className="max-w-md text-sm italic text-sepia">
          Va chercher les derniers articles de tes catégories FreshRSS et reconstruit l’édition,
          sans attendre demain matin.
        </p>
        <button
          onClick={pull}
          disabled={pulling}
          className="stamp-button border-2 border-ink bg-ink px-5 py-2.5 font-display text-xs uppercase tracking-[0.25em] text-paper transition-colors hover:bg-paper hover:text-ink disabled:opacity-50"
        >
          {pulling ? "Aspiration en cours..." : "Aspirer les news"}
        </button>
        {message && <p className="text-sm italic text-sepia">{message}</p>}
      </div>

      {initialArticles.length === 0 ? (
        <p className="py-24 text-center italic text-sepia">
          Rien pour l’instant — clique sur « Aspirer les news » pour aller chercher les derniers
          articles.
        </p>
      ) : (
        <EditionView articles={initialArticles} />
      )}
    </div>
  );
}
