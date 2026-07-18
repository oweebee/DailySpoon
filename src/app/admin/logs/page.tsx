"use client";

import { useEffect, useRef, useState } from "react";

type LogLevel = "info" | "warn" | "error";

type LogEntry = {
  id: string;
  createdAt: string;
  level: LogLevel;
  source: string;
  message: string;
  detail: string | null;
};

// Mêmes valeurs que src/lib/logger.ts (LOG_RETENTION_OPTIONS) — dupliqué ici
// volontairement (composant client, pas d'import direct d'un module server
// qui touche à Prisma).
const RETENTION_OPTIONS = [
  { value: 60, label: "1 heure" },
  { value: 1440, label: "1 jour" },
  { value: 10080, label: "1 semaine" },
  { value: 43200, label: "1 mois" },
  { value: 0, label: "Illimité" }
];

const LEVEL_OPTIONS: { value: "all" | LogLevel; label: string }[] = [
  { value: "all", label: "Tout" },
  { value: "info", label: "Info" },
  { value: "warn", label: "Avertissement" },
  { value: "error", label: "Erreur" }
];

// Rafraîchissement auto — assez rapide pour suivre une récupération de flux
// en cours sans avoir à cliquer, sans non plus solliciter le serveur en
// continu (c'est une simple lecture, coût négligeable).
const AUTO_REFRESH_MS = 10_000;

function levelBadgeClass(level: LogLevel): string {
  if (level === "error") return "border-journal text-journal";
  if (level === "warn") return "border-ink/60 text-ink";
  return "border-ink/30 text-sepia";
}

function formatTimestamp(iso: string): string {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(iso));
}

export default function AdminLogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [levelFilter, setLevelFilter] = useState<"all" | LogLevel>("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const [retentionMinutes, setRetentionMinutes] = useState<number>(1440);
  const [retentionSaving, setRetentionSaving] = useState(false);
  const [retentionMessage, setRetentionMessage] = useState<string | null>(null);

  const [clearing, setClearing] = useState(false);

  // Évite un chevauchement si un chargement précédent traîne encore quand
  // l'intervalle auto-refresh en relance un nouveau (filtre changé pendant
  // ce temps, par ex.).
  const requestIdRef = useRef(0);

  async function loadLogs() {
    const thisRequest = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (levelFilter !== "all") params.set("level", levelFilter);
    if (sourceFilter !== "all") params.set("source", sourceFilter);

    const res = await fetch(`/api/admin/logs?${params.toString()}`);
    const body = await res.json().catch(() => ({}));
    if (thisRequest !== requestIdRef.current) return; // réponse obsolète, ignorée

    if (!res.ok) {
      setError(body.error || "Impossible de charger le journal");
    } else {
      setLogs(body.logs || []);
      setSources(body.sources || []);
    }
    setLoading(false);
  }

  async function loadRetention() {
    const res = await fetch("/api/admin/settings");
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.settings?.logRetentionMinutes !== undefined) {
      setRetentionMinutes(body.settings.logRetentionMinutes);
    }
  }

  useEffect(() => {
    loadRetention();
  }, []);

  useEffect(() => {
    loadLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelFilter, sourceFilter]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(loadLogs, AUTO_REFRESH_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, levelFilter, sourceFilter]);

  async function saveRetention(value: number) {
    setRetentionMinutes(value);
    setRetentionSaving(true);
    setRetentionMessage(null);
    const res = await fetch("/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ logRetentionMinutes: value })
    });
    setRetentionMessage(res.ok ? "Rétention enregistrée." : "Échec de l'enregistrement.");
    setRetentionSaving(false);
  }

  async function clearLogs() {
    if (!window.confirm("Vider tout le journal ? Cette action est irréversible.")) return;
    setClearing(true);
    await fetch("/api/admin/logs", { method: "DELETE" });
    await loadLogs();
    setClearing(false);
  }

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" });
    window.location.href = "/admin/login";
  }

  return (
    <main className="paper-panel mx-auto w-full lg:w-3/4 rounded-sm px-6 py-10 shadow-[0_10px_60px_-15px_rgba(26,26,26,0.35)] ring-1 ring-ink/10 md:px-10 md:py-14">
      <div className="mb-8 text-center">
        <a href="/" className="font-masthead text-4xl font-black uppercase tracking-tight">
          DailySpoon
        </a>
        <div className="double-rule mt-3" />
        <div className="flex items-center justify-between py-1.5 text-[0.65rem] uppercase tracking-[0.3em] text-sepia">
          <a href="/admin/categories" className="hover:underline">
            ← Catégories
          </a>
          <a href="/admin/settings" className="hover:underline">
            Réglages
          </a>
          <button onClick={logout} className="uppercase tracking-[0.3em] hover:underline">
            Se déconnecter
          </button>
        </div>
        <div className="double-rule rotate-180" />
      </div>

      <h1 className="mb-6 text-center font-display text-2xl font-black uppercase tracking-[0.15em]">Journal</h1>

      <p className="newsprint mb-8 text-sm text-neutral-700">
        Trace en direct la récupération des flux (persos et FreshRSS), la génération de l'édition, les
        appels IA et le worker — pour voir d'un coup d'œil si tout se passe bien, sans aller fouiller
        les logs bruts du serveur. Se rafraîchit automatiquement toutes les {AUTO_REFRESH_MS / 1000}{" "}
        secondes.
      </p>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b-2 border-ink pb-6">
        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-[0.15em] text-neutral-600">
            Rétention du journal
          </span>
          <select
            value={retentionMinutes}
            onChange={(e) => saveRetention(Number(e.target.value))}
            disabled={retentionSaving}
            className="border border-ink/40 bg-paper px-3 py-2 font-serif text-sm focus:outline-none focus:ring-1 focus:ring-ink"
          >
            {RETENTION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {retentionMessage && <p className="mt-1 text-xs italic text-sepia">{retentionMessage}</p>}
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs italic text-sepia">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="accent-ink"
            />
            auto-rafraîchissement
          </label>
          <button
            type="button"
            onClick={loadLogs}
            className="border border-ink px-3 py-2 text-xs uppercase tracking-[0.2em] hover:bg-ink hover:text-paper"
          >
            Rafraîchir
          </button>
          <button
            type="button"
            onClick={clearLogs}
            disabled={clearing}
            className="border border-journal px-3 py-2 text-xs uppercase tracking-[0.2em] text-journal hover:bg-journal hover:text-paper disabled:opacity-50"
          >
            {clearing ? "Vidage..." : "Vider le journal"}
          </button>
        </div>
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        {LEVEL_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setLevelFilter(opt.value)}
            className={`border px-3 py-1 text-xs uppercase tracking-[0.15em] transition-colors ${
              levelFilter === opt.value ? "border-ink bg-ink text-paper" : "border-ink/30 text-sepia hover:border-ink"
            }`}
          >
            {opt.label}
          </button>
        ))}
        {sources.length > 0 && (
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="border border-ink/30 bg-paper px-2 py-1 text-xs uppercase tracking-[0.15em] text-sepia focus:outline-none focus:ring-1 focus:ring-ink"
          >
            <option value="all">Toutes les sources</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && <p className="mb-4 text-sm text-journal">{error}</p>}

      {loading && logs.length === 0 ? (
        <p className="py-8 text-center italic text-sepia">Chargement...</p>
      ) : logs.length === 0 ? (
        <p className="py-8 text-center italic text-sepia">Aucune entrée pour l’instant.</p>
      ) : (
        <ul className="border-t-2 border-ink">
          {logs.map((entry) => {
            const isExpanded = expandedIds.has(entry.id);
            return (
              <li key={entry.id} className="border-b border-ink/30 py-2.5">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="shrink-0 font-mono text-xs text-sepia">{formatTimestamp(entry.createdAt)}</span>
                  <span
                    className={`shrink-0 rounded-sm border px-1.5 py-0.5 text-[0.55rem] uppercase tracking-[0.15em] ${levelBadgeClass(entry.level)}`}
                  >
                    {entry.level}
                  </span>
                  <span className="shrink-0 rounded-sm border border-ink/30 px-1.5 py-0.5 text-[0.55rem] uppercase tracking-[0.15em] text-sepia">
                    {entry.source}
                  </span>
                  <span className="text-sm">{entry.message}</span>
                  {entry.detail && (
                    <button
                      type="button"
                      onClick={() => toggleExpanded(entry.id)}
                      className="ml-auto shrink-0 text-xs uppercase tracking-[0.15em] text-sepia hover:underline"
                    >
                      {isExpanded ? "Masquer" : "Détail"}
                    </button>
                  )}
                </div>
                {isExpanded && entry.detail && (
                  <pre className="mt-1.5 whitespace-pre-wrap break-words border border-ink/20 bg-ink/5 p-2 text-xs text-neutral-700">
                    {entry.detail}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
