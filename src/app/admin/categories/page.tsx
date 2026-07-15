"use client";

import { useEffect, useState } from "react";

type Category = {
  freshrssId: string;
  label: string;
  selected: boolean;
};

export default function AdminCategoriesPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => {
    loadCategories();
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

  async function regenerate() {
    setGenerating(true);
    setGenResult(null);
    const res = await fetch("/api/cron/generate", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    setGenerating(false);
    setGenResult(res.ok ? `Édition mise à jour : ${body.articleCount} articles.` : body.error || "Échec");
  }

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" });
    window.location.href = "/admin/login";
  }

  return (
    <main className="max-w-3xl mx-auto px-6 py-10 font-sans">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold">Catégories FreshRSS</h1>
        <button onClick={logout} className="text-sm underline">
          Se déconnecter
        </button>
      </div>

      <p className="text-sm text-neutral-600 mb-6">
        La gestion des flux (ajout, suppression, organisation) se fait directement dans FreshRSS.
        Ici, tu choisis simplement quelles catégories FreshRSS DailySpoon doit inclure dans l’édition
        du jour.
      </p>

      <div className="mb-8 flex items-center gap-3">
        <button
          onClick={regenerate}
          disabled={generating}
          className="bg-ink text-paper rounded px-4 py-2 text-sm disabled:opacity-50"
        >
          {generating ? "Génération en cours..." : "Régénérer l’édition maintenant"}
        </button>
        {genResult && <span className="text-sm text-neutral-600">{genResult}</span>}
      </div>

      {loading ? (
        <p className="text-neutral-500">Chargement depuis FreshRSS...</p>
      ) : error ? (
        <div className="text-red-600 text-sm space-y-2">
          <p>{error}</p>
          <p className="text-neutral-600">
            Vérifie FRESHRSS_BASE_URL, FRESHRSS_USERNAME et FRESHRSS_API_PASSWORD dans les
            variables d’environnement.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-neutral-300">
          {categories.map((cat) => (
            <li key={cat.freshrssId} className="py-3 flex items-center justify-between gap-4">
              <span className="font-medium">{cat.label}</span>
              <label className="text-xs flex items-center gap-1">
                <input type="checkbox" checked={cat.selected} onChange={() => toggle(cat)} />
                inclure dans l’édition
              </label>
            </li>
          ))}
          {categories.length === 0 && (
            <p className="text-neutral-500 py-6">Aucune catégorie trouvée dans FreshRSS.</p>
          )}
        </ul>
      )}
    </main>
  );
}
