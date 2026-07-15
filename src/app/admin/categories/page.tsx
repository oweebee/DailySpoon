"use client";

import { useEffect, useState } from "react";

type Category = {
  freshrssId: string;
  label: string;
  selected: boolean;
};

type Feed = {
  freshrssId: string;
  title: string;
  categoryLabels: string[];
  included: boolean;
};

export default function AdminCategoriesPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [feedsLoading, setFeedsLoading] = useState(true);
  const [feedsError, setFeedsError] = useState<string | null>(null);

  const [generating, setGenerating] = useState(false);
  const [genResult, setGenResult] = useState<string | null>(null);

  async function loadCategories() {
    setLoading(true);
    setError(null);
    const res = await fetch("/api/admin/categories");
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error || "Impossible de charger les catégories FreshRSS");
      setCategories([]);
    } else {
      setCategories(body.categories || []);
    }
    setLoading(false);
  }

  async function loadFeeds() {
    setFeedsLoading(true);
    setFeedsError(null);
    const res = await fetch("/api/admin/feeds");
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setFeedsError(body.error || "Impossible de charger les flux FreshRSS");
      setFeeds([]);
    } else {
      setFeeds(body.feeds || []);
    }
    setFeedsLoading(false);
  }

  useEffect(() => {
    loadCategories();
    loadFeeds();
  }, []);

  async function toggle(cat: Category) {
    setCategories((prev) =>
      prev.map((c) => (c.freshrssId === cat.freshrssId ? { ...c, selected: !c.selected } : c))
    );
    await fetch("/api/admin/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ freshrssId: cat.freshrssId, label: cat.label, selected: !cat.selected })
    });
  }

  async function toggleFeed(feed: Feed) {
    setFeeds((prev) =>
      prev.map((f) => (f.freshrssId === feed.freshrssId ? { ...f, included: !f.included } : f))
    );
    await fetch("/api/admin/feeds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ freshrssId: feed.freshrssId, title: feed.title, included: !feed.included })
    });
  }

  async function regenerate() {
    setGenerating(true);
    setGenResult(null);
    const res = await fetch("/api/cron/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    const body = await res.json().catch(() => ({}));
    setGenerating(false);
    setGenResult(res.ok ? `Édition mise à jour : ${body.articleCount} articles.` : body.error || "Échec");
  }

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" });
    window.location.href = "/admin/login";
  }

  return (
    <main className="mx-auto w-full lg:w-3/4 rounded-sm bg-paper/70 px-6 py-10 shadow-[0_10px_60px_-15px_rgba(26,26,26,0.35)] ring-1 ring-ink/10 md:px-10 md:py-14">
      {/* Masthead miniature */}
      <div className="mb-8 text-center">
        <a href="/" className="font-masthead text-4xl font-black uppercase tracking-tight">
          DailySpoon
        </a>
        <div className="double-rule mt-3" />
        <div className="flex items-center justify-between py-1.5 text-[0.65rem] uppercase tracking-[0.3em] text-sepia">
          <a href="/admin/settings" className="hover:underline">
            Réglages →
          </a>
          <button onClick={logout} className="uppercase tracking-[0.3em] hover:underline">
            Se déconnecter
          </button>
        </div>
        <div className="double-rule rotate-180" />
      </div>

      <h1 className="mb-6 text-center font-display text-2xl font-black uppercase tracking-[0.15em]">
        Catégories & flux FreshRSS
      </h1>

      <p className="newsprint mb-6 text-sm text-neutral-700">
        La gestion des flux (ajout, suppression, organisation) se fait directement dans FreshRSS.
        Ici, tu choisis quelles catégories — et quels flux précis — DailySpoon doit inclure. Décocher
        une catégorie ou un flux le retire immédiatement de l’édition (partout, articles déjà
        récupérés compris), pas seulement des futures récupérations.
      </p>

      <div className="mb-8 flex items-center gap-3">
        <button
          onClick={regenerate}
          disabled={generating}
          className="stamp-button border-2 border-ink bg-ink px-4 py-2 font-display text-xs uppercase tracking-[0.2em] text-paper transition-colors hover:bg-paper hover:text-ink disabled:opacity-50"
        >
          {generating ? "Génération en cours..." : "Régénérer l’édition maintenant"}
        </button>
        {genResult && <span className="text-sm italic text-sepia">{genResult}</span>}
      </div>

      <h2 className="mb-4 border-y-2 border-ink py-1.5 text-center font-display text-sm font-bold uppercase tracking-[0.3em]">
        Catégories
      </h2>

      {loading ? (
        <p className="italic text-sepia">Chargement depuis FreshRSS...</p>
      ) : error ? (
        <div className="space-y-2 text-sm text-journal">
          <p>{error}</p>
          <p className="text-neutral-700">
            Vérifie l’URL, l’identifiant et le mot de passe API FreshRSS dans{" "}
            <a href="/admin/settings" className="underline">
              /admin/settings
            </a>{" "}
            (ou les variables d’environnement FRESHRSS_BASE_URL / FRESHRSS_USERNAME /
            FRESHRSS_API_PASSWORD).
          </p>
        </div>
      ) : (
        <ul className="border-t-2 border-ink">
          {categories.map((cat) => (
            <li
              key={cat.freshrssId}
              className="flex items-center justify-between gap-4 border-b border-ink/30 py-3"
            >
              <span className="font-display font-bold">{cat.label}</span>
              <label className="flex items-center gap-2 text-xs italic text-sepia">
                <input
                  type="checkbox"
                  checked={cat.selected}
                  onChange={() => toggle(cat)}
                  className="accent-ink"
                />
                inclure dans l’édition
              </label>
            </li>
          ))}
          {categories.length === 0 && (
            <p className="py-6 text-center italic text-sepia">
              Aucune catégorie trouvée dans FreshRSS.
            </p>
          )}
        </ul>
      )}

      <h2 className="mb-4 mt-12 border-y-2 border-ink py-1.5 text-center font-display text-sm font-bold uppercase tracking-[0.3em]">
        Flux
      </h2>

      {feedsLoading ? (
        <p className="italic text-sepia">Chargement des flux...</p>
      ) : feedsError ? (
        <p className="text-sm text-journal">{feedsError}</p>
      ) : (
        <ul className="border-t-2 border-ink">
          {feeds.map((feed) => (
            <li
              key={feed.freshrssId}
              className="flex items-center justify-between gap-4 border-b border-ink/30 py-3"
            >
              <div>
                <span className="font-display font-bold">{feed.title}</span>
                {feed.categoryLabels.length > 0 && (
                  <span className="ml-2 text-xs italic text-sepia">
                    ({feed.categoryLabels.join(", ")})
                  </span>
                )}
              </div>
              <label className="flex items-center gap-2 text-xs italic text-sepia">
                <input
                  type="checkbox"
                  checked={feed.included}
                  onChange={() => toggleFeed(feed)}
                  className="accent-ink"
                />
                inclure dans l’édition
              </label>
            </li>
          ))}
          {feeds.length === 0 && (
            <p className="py-6 text-center italic text-sepia">Aucun flux trouvé dans FreshRSS.</p>
          )}
        </ul>
      )}

      <p className="mt-14 text-center text-xl tracking-[0.5em] text-sepia">❦ ❦ ❦</p>
    </main>
  );
}
