"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type SearchArticle = {
  id: string;
  headline: string | null;
  publishedAt: string | Date | null;
  edition?: { date: string | Date } | null;
};

type DayResult = { key: string; label: string; headlines: string[]; year: number; month: number };

/**
 * Même champ de recherche que "En direct" (réutilise /api/articles/search,
 * déjà accéléré par les index trigram pg_trgm), mais regroupé par JOUR
 * d'édition plutôt que par article : dans les archives, on cherche à savoir
 * QUEL JOUR consulter, pas à lire l'article directement ici — pour ça, on
 * passe par /direct + la date, comme demandé.
 *
 * Renvoie vers la liste /archive filtrée sur le mois (pas directement vers
 * une édition précise) : plusieurs éditions peuvent désormais partager le
 * même jour (chaque régénération est conservée séparément), et le champ
 * "edition" d'un article ne pointe de toute façon que vers la DERNIÈRE
 * édition l'ayant touché — pas de cible unique fiable pour un lien direct.
 */
export function ArchiveSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchArticle[] | null>(null);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/articles/search?q=${encodeURIComponent(q)}`);
        const body = await res.json().catch(() => ({}));
        setResults(body.articles || []);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const isSearching = query.trim().length > 0;
  const days = groupByDay(results);

  return (
    <div className="mb-10">
      <div className="mb-6 flex justify-center">
        <label className="flex items-center gap-2 border-b border-ink/40 pb-1 focus-within:border-journal">
          <WesternMagnifier className="h-4 w-4 shrink-0 text-ink/70" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher dans les archives…"
            className="w-56 bg-transparent text-sm italic text-ink placeholder:text-sepia/70 focus:outline-none sm:w-72"
          />
        </label>
      </div>

      {isSearching && (
        <div className="border-t-2 border-ink pt-4">
          {searching && !results ? (
            <p className="py-6 text-center italic text-sepia">Recherche…</p>
          ) : days.length === 0 ? (
            <p className="py-6 text-center italic text-sepia">
              Aucun jour ne correspond à cette recherche.
            </p>
          ) : (
            <ul className="divide-y divide-ink/20">
              {days.map((day) => (
                <li key={day.key} className="flex items-baseline justify-between gap-4 py-3">
                  <Link
                    href={`/archive?year=${day.year}&month=${day.month + 1}`}
                    className="font-display text-base capitalize hover:underline"
                  >
                    {day.label}
                  </Link>
                  <span className="max-w-[60%] truncate text-right text-xs italic text-sepia">
                    {day.headlines.join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function groupByDay(results: SearchArticle[] | null): DayResult[] {
  if (!results) return [];
  const byKey = new Map<string, DayResult>();
  for (const a of results) {
    // Regroupé par date de PUBLICATION de l'article (publishedAt), pas par
    // date de génération de son édition (edition.date) : les deux peuvent
    // diverger (un article publié le 10 peut n'être récupéré/inclus dans une
    // édition que le 16), et chercher "10 juillet" doit faire remonter le
    // 10, pas le jour où l'édition correspondante a été générée.
    if (!a.publishedAt) continue;
    const d = new Date(a.publishedAt);
    const key = d.toISOString().slice(0, 10);
    if (!byKey.has(key)) {
      const label = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" }).format(d);
      byKey.set(key, { key, label, headlines: [], year: d.getUTCFullYear(), month: d.getUTCMonth() });
    }
    const entry = byKey.get(key)!;
    if (entry.headlines.length < 3 && a.headline) entry.headlines.push(a.headline);
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? 1 : -1));
}

function WesternMagnifier({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    >
      <circle cx="10" cy="10" r="6.5" />
      <line x1="14.6" y1="14.6" x2="21" y2="21" strokeWidth="2.2" />
      <line x1="15.3" y1="15.9" x2="16.4" y2="14.8" strokeWidth="0.9" />
      <line x1="16.8" y1="17.4" x2="17.9" y2="16.3" strokeWidth="0.9" />
      <line x1="18.3" y1="18.9" x2="19.4" y2="17.8" strokeWidth="0.9" />
    </svg>
  );
}
