"use client";

import { useEffect, useState } from "react";
import { SpoonDivider } from "@/components/SpoonDivider";

type SettingsForm = {
  freshrssBaseUrl: string;
  freshrssUsername: string;
  freshrssApiPassword: string;
  anthropicApiKey: string;
  anthropicModel: string;
  aiProvider: string;
  geminiApiKey: string;
  geminiModel: string;
  editionHour: string;
  editionMinute: string;
  editionTz: string;
  retentionDays: string;
  editionScheduleEnabled: boolean;
  writingStyle: string;
  morssBaseUrl: string;
  customFeedsIntervalMinutes: string;
};

const EMPTY: SettingsForm = {
  freshrssBaseUrl: "",
  freshrssUsername: "",
  freshrssApiPassword: "",
  anthropicApiKey: "",
  anthropicModel: "",
  aiProvider: "anthropic",
  geminiApiKey: "",
  geminiModel: "",
  editionHour: "",
  editionMinute: "",
  editionTz: "",
  retentionDays: "730",
  editionScheduleEnabled: true,
  writingStyle: "normal",
  morssBaseUrl: "",
  customFeedsIntervalMinutes: "60"
};

// Styles d'écriture disponibles pour la réécriture IA — "normal" (ton
// journalistique neutre, comportement historique), "ackboo" (sarcastique/
// passif-agressif façon Ackboo, Canard PC), "darksasuke" (cynique,
// associal, jamais content, coloration nationaliste assumée — voir
// WRITING_STYLES dans src/lib/ai.ts pour les garde-fous) ou "random" (tire un
// style au hasard parmi les 3 précédents à CHAQUE génération — voir
// resolveWritingStyle dans src/lib/ai.ts ; le style effectivement tiré est
// figé sur l'édition et visible dans /archive, jamais "random" tel quel).
// Sans effet sur /direct.
const WRITING_STYLE_OPTIONS = [
  { value: "normal", label: "Normal" },
  { value: "ackboo", label: "Ackboo" },
  { value: "darksasuke", label: "Dark Sasuke" },
  { value: "random", label: "Aléatoire" }
];

// 6 mois à 5 ans, puis illimité (0 = jamais purgé). Les favoris échappent
// de toute façon à la purge, quelle que soit cette valeur.
const RETENTION_OPTIONS = [
  { value: "180", label: "6 mois" },
  { value: "365", label: "1 an" },
  { value: "730", label: "2 ans (défaut)" },
  { value: "1095", label: "3 ans" },
  { value: "1460", label: "4 ans" },
  { value: "1825", label: "5 ans" },
  { value: "0", label: "Illimité" }
];

// Intervalle GLOBAL de récupération RSS — gouverne à la fois les flux
// personnalisés (catégories personnalisées, /admin/categories, voir
// customFeeds.ts) ET l'aspiration RSS de secours FreshRSS en mode manuel
// (voir worker/index.ts, plus de durée fixe séparée pour cette dernière) —
// un seul intervalle pour tout ça, pas de réglage par flux ni par catégorie.
const CUSTOM_FEEDS_INTERVAL_OPTIONS = [
  { value: "5", label: "5 minutes" },
  { value: "15", label: "15 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "60", label: "1 heure (défaut)" },
  { value: "180", label: "3 heures" },
  { value: "360", label: "6 heures" },
  { value: "480", label: "8 heures" },
  { value: "1440", label: "24 heures" },
  { value: "10080", label: "1 semaine" }
];

type TestResult = { ok: boolean; message: string };
type GeminiModel = { id: string; displayName: string };

export default function AdminSettingsPage() {
  const [form, setForm] = useState<SettingsForm>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<{
    freshrss?: TestResult;
    anthropic?: TestResult;
    gemini?: TestResult;
  } | null>(null);
  const [geminiModels, setGeminiModels] = useState<GeminiModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/settings")
      .then((res) => res.json())
      .then((body) => {
        const s = body.settings || {};
        setForm({
          freshrssBaseUrl: s.freshrssBaseUrl || "",
          freshrssUsername: s.freshrssUsername || "",
          freshrssApiPassword: s.freshrssApiPassword || "",
          anthropicApiKey: s.anthropicApiKey || "",
          anthropicModel: s.anthropicModel || "",
          aiProvider: s.aiProvider || "anthropic",
          geminiApiKey: s.geminiApiKey || "",
          geminiModel: s.geminiModel || "",
          editionHour: s.editionHour?.toString() ?? "",
          editionMinute: s.editionMinute?.toString() ?? "",
          editionTz: s.editionTz || "",
          retentionDays: s.retentionDays !== undefined && s.retentionDays !== null ? s.retentionDays.toString() : "730",
          editionScheduleEnabled: s.editionScheduleEnabled ?? true,
          writingStyle: s.writingStyle || "normal",
          morssBaseUrl: s.morssBaseUrl || "",
          customFeedsIntervalMinutes:
            s.customFeedsIntervalMinutes !== undefined && s.customFeedsIntervalMinutes !== null
              ? s.customFeedsIntervalMinutes.toString()
              : "60"
        });
        // Clé déjà enregistrée : charge tout de suite la liste des moteurs
        // disponibles, pour ne pas obliger à cliquer avant de pouvoir choisir.
        // Le moteur déjà enregistré (s.geminiModel) est passé explicitement
        // ici plutôt que lu depuis `form` : à cet instant, le state React
        // issu du setForm ci-dessus n'est pas encore appliqué (closure figée
        // sur l'ancien `form.geminiModel`, vide) — sans ce paramètre,
        // loadGeminiModels croyait toujours qu'aucun moteur n'était choisi
        // et écrasait systématiquement avec le premier de la liste au
        // rechargement de la page.
        if (s.geminiApiKey) loadGeminiModels(s.geminiApiKey, s.geminiModel || "");
      })
      .finally(() => setLoading(false));
  }, []);

  async function loadGeminiModels(apiKey: string, currentModel?: string) {
    if (!apiKey) {
      setModelsError("Renseigne d'abord une clé API Gemini.");
      return;
    }
    setLoadingModels(true);
    setModelsError(null);
    try {
      const res = await fetch("/api/admin/settings/gemini-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setModelsError(body.error || "Échec du chargement des moteurs.");
        setGeminiModels([]);
      } else {
        setGeminiModels(body.models || []);
        // Si aucun moteur n'est encore choisi (première config), on
        // présélectionne le premier de la liste plutôt que de laisser le
        // champ vide. `currentModel`, quand fourni par l'appelant, prime sur
        // `form.geminiModel` (qui peut être périmé — voir l'appel initial
        // dans le useEffect ci-dessus).
        const preferred = currentModel !== undefined ? currentModel : form.geminiModel;
        if (!preferred && body.models?.[0]) {
          set("geminiModel", body.models[0].id);
        }
      }
    } catch {
      setModelsError("Impossible de joindre l'API Gemini.");
      setGeminiModels([]);
    } finally {
      setLoadingModels(false);
    }
  }

  function set<K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function payload() {
    return {
      freshrssBaseUrl: form.freshrssBaseUrl,
      freshrssUsername: form.freshrssUsername,
      freshrssApiPassword: form.freshrssApiPassword,
      anthropicApiKey: form.anthropicApiKey,
      anthropicModel: form.anthropicModel,
      aiProvider: form.aiProvider,
      geminiApiKey: form.geminiApiKey,
      geminiModel: form.geminiModel,
      editionHour: form.editionHour === "" ? null : Number(form.editionHour),
      editionMinute: form.editionMinute === "" ? null : Number(form.editionMinute),
      editionTz: form.editionTz,
      retentionDays: form.retentionDays === "" ? null : Number(form.retentionDays),
      editionScheduleEnabled: form.editionScheduleEnabled,
      writingStyle: form.writingStyle,
      morssBaseUrl: form.morssBaseUrl,
      customFeedsIntervalMinutes:
        form.customFeedsIntervalMinutes === "" ? null : Number(form.customFeedsIntervalMinutes)
    };
  }

  async function save() {
    setSaving(true);
    setSaveMessage(null);
    const res = await fetch("/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload())
    });
    setSaving(false);
    setSaveMessage(res.ok ? "Réglages enregistrés." : "Échec de l'enregistrement.");
  }

  async function test() {
    setTesting(true);
    setTestResults(null);
    const res = await fetch("/api/admin/settings/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload())
    });
    const body = await res.json().catch(() => ({}));
    setTesting(false);
    setTestResults(body);
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
          <button onClick={logout} className="uppercase tracking-[0.3em] hover:underline">
            Se déconnecter
          </button>
        </div>
        <div className="double-rule rotate-180" />
      </div>

      <h1 className="mb-6 text-center font-display text-2xl font-black uppercase tracking-[0.15em]">
        Réglages
      </h1>

      <p className="newsprint mb-8 text-sm text-neutral-700">
        Ces valeurs remplacent les variables d’environnement une fois enregistrées ici — pas besoin
        de redéployer pour changer un mot de passe ou l’heure de l’édition. Laisse un champ vide
        pour revenir à la variable d’environnement correspondante.
      </p>

      {loading ? (
        <p className="italic text-sepia">Chargement...</p>
      ) : (
        <div className="space-y-8">
          <fieldset className="space-y-3 border-t-2 border-ink pt-4">
            <legend className="mb-1 font-display text-xs uppercase tracking-[0.2em]">FreshRSS</legend>
            <Field
              label="URL de base"
              value={form.freshrssBaseUrl}
              onChange={(v) => set("freshrssBaseUrl", v)}
              placeholder="https://rss.exemple.com"
            />
            <Field
              label="Identifiant"
              value={form.freshrssUsername}
              onChange={(v) => set("freshrssUsername", v)}
            />
            <Field
              label="Mot de passe API"
              value={form.freshrssApiPassword}
              onChange={(v) => set("freshrssApiPassword", v)}
              type="password"
            />
            {testResults?.freshrss && (
              <p className={`text-sm italic ${testResults.freshrss.ok ? "text-sepia" : "text-journal"}`}>
                {testResults.freshrss.ok ? "✓ " : "✗ "}
                {testResults.freshrss.message}
              </p>
            )}
          </fieldset>

          <fieldset className="space-y-3 border-t-2 border-ink pt-4">
            <legend className="mb-1 font-display text-xs uppercase tracking-[0.2em]">IA</legend>
            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-[0.15em] text-neutral-600">
                Fournisseur
              </span>
              <select
                value={form.aiProvider}
                onChange={(e) => set("aiProvider", e.target.value)}
                className="w-full border border-ink/40 bg-paper px-3 py-2 font-serif text-sm focus:outline-none focus:ring-1 focus:ring-ink"
              >
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="gemini">Google Gemini</option>
              </select>
            </label>
            <p className="text-xs italic text-sepia">
              Ne change que le moteur utilisé pour l’édition IA — « Aspirer les news » sur /direct
              reste toujours sans IA, quel que soit ce choix.
            </p>

            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-[0.15em] text-neutral-600">
                Style d’écriture
              </span>
              <select
                value={form.writingStyle}
                onChange={(e) => set("writingStyle", e.target.value)}
                className="w-full border border-ink/40 bg-paper px-3 py-2 font-serif text-sm focus:outline-none focus:ring-1 focus:ring-ink"
              >
                {WRITING_STYLE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-xs italic text-sepia">
              « Ackboo » : ton sarcastique, passif-agressif et cynique façon Canard PC — appliqué aux
              titres et résumés réécrits par l’IA. « Normal » garde le ton journalistique neutre
              habituel. « Aléatoire » tire un style au hasard parmi les précédents à chaque
              impression (le style réellement tiré reste visible dans /archive). Sans effet sur
              /direct, toujours sans IA.
            </p>

            <div className="space-y-3 border-t border-ink/20 pt-3">
              <p className="text-xs uppercase tracking-[0.15em] text-neutral-600">Anthropic</p>
              <Field
                label="Clé API"
                value={form.anthropicApiKey}
                onChange={(v) => set("anthropicApiKey", v)}
                type="password"
              />
              <Field
                label="Modèle"
                value={form.anthropicModel}
                onChange={(v) => set("anthropicModel", v)}
                placeholder="claude-sonnet-4-5"
              />
              {testResults?.anthropic && (
                <p className={`text-sm italic ${testResults.anthropic.ok ? "text-sepia" : "text-journal"}`}>
                  {testResults.anthropic.ok ? "✓ " : "✗ "}
                  {testResults.anthropic.message}
                </p>
              )}
            </div>

            <div className="space-y-3 border-t border-ink/20 pt-3">
              <p className="text-xs uppercase tracking-[0.15em] text-neutral-600">Google Gemini</p>
              <Field
                label="Clé API"
                value={form.geminiApiKey}
                onChange={(v) => set("geminiApiKey", v)}
                type="password"
              />
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  {geminiModels.length > 0 ? (
                    <label className="block">
                      <span className="mb-1 block text-xs uppercase tracking-[0.15em] text-neutral-600">
                        Moteur
                      </span>
                      <select
                        value={form.geminiModel}
                        onChange={(e) => set("geminiModel", e.target.value)}
                        className="w-full border border-ink/40 bg-paper px-3 py-2 font-serif text-sm focus:outline-none focus:ring-1 focus:ring-ink"
                      >
                        {!geminiModels.some((m) => m.id === form.geminiModel) && form.geminiModel && (
                          <option value={form.geminiModel}>{form.geminiModel}</option>
                        )}
                        {geminiModels.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.displayName}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <Field
                      label="Modèle"
                      value={form.geminiModel}
                      onChange={(v) => set("geminiModel", v)}
                      placeholder="gemini-3.5-flash"
                    />
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => loadGeminiModels(form.geminiApiKey)}
                  disabled={loadingModels}
                  className="border border-ink/40 bg-paper px-3 py-2 text-xs uppercase tracking-[0.15em] text-ink transition-colors hover:bg-ink hover:text-paper disabled:opacity-50"
                >
                  {loadingModels ? "Chargement..." : geminiModels.length > 0 ? "Actualiser" : "Charger les moteurs"}
                </button>
              </div>
              {modelsError && <p className="text-xs italic text-journal">{modelsError}</p>}
              {testResults?.gemini && (
                <p className={`text-sm italic ${testResults.gemini.ok ? "text-sepia" : "text-journal"}`}>
                  {testResults.gemini.ok ? "✓ " : "✗ "}
                  {testResults.gemini.message}
                </p>
              )}
            </div>
          </fieldset>

          <fieldset className="space-y-3 border-t-2 border-ink pt-4">
            <legend className="mb-1 font-display text-xs uppercase tracking-[0.2em]">
              Horaire de l’édition
            </legend>
            <div className="flex gap-3">
              <Field
                label="Heure (0-23)"
                value={form.editionHour}
                onChange={(v) => set("editionHour", v)}
                placeholder="6"
              />
              <Field
                label="Minute (0-59)"
                value={form.editionMinute}
                onChange={(v) => set("editionMinute", v)}
                placeholder="0"
              />
            </div>
            <Field
              label="Fuseau horaire"
              value={form.editionTz}
              onChange={(v) => set("editionTz", v)}
              placeholder="Europe/Paris"
            />
            <label className="flex items-center gap-2 text-xs italic text-sepia">
              <input
                type="checkbox"
                checked={form.editionScheduleEnabled}
                onChange={(e) => set("editionScheduleEnabled", e.target.checked)}
                className="accent-journal"
              />
              Génération automatique activée
            </label>
            {!form.editionScheduleEnabled && (
              <p className="text-xs italic text-sepia">
                Planning désactivé — un bouton « Lancer l’impression du journal » apparaît sur la
                page d’accueil pour déclencher la génération à la main.
              </p>
            )}
          </fieldset>

          <fieldset className="space-y-3 border-t-2 border-ink pt-4">
            <legend className="mb-1 font-display text-xs uppercase tracking-[0.2em]">
              Rétention de l’historique
            </legend>
            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-[0.15em] text-neutral-600">
                Durée de conservation des articles
              </span>
              <select
                value={form.retentionDays}
                onChange={(e) => set("retentionDays", e.target.value)}
                className="w-full border border-ink/40 bg-paper px-3 py-2 font-serif text-sm focus:outline-none focus:ring-1 focus:ring-ink"
              >
                {RETENTION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-xs italic text-sepia">
              Passé ce délai, les articles sont supprimés automatiquement à chaque génération —
              sauf ceux marqués favoris, jamais purgés.
            </p>
          </fieldset>

          <fieldset className="space-y-3 border-t-2 border-ink pt-4">
            <legend className="mb-1 font-display text-xs uppercase tracking-[0.2em]">
              Lecture d’article (morss)
            </legend>
            <Field
              label="Base de l’instance morss"
              value={form.morssBaseUrl}
              onChange={(v) => set("morssBaseUrl", v)}
              placeholder="https://morss.exemple.com"
            />
            <p className="text-xs italic text-sepia">
              Utilisée en repli quand la lecture directe d’un article échoue (403, blocage anti-bot —
              ex. NYTimes, Cloudflare) : la requête repart depuis morss plutôt que directement depuis
              ce serveur. Laisse vide pour désactiver ce repli. Sans lien avec un flux déjà proxifié
              via morss côté FreshRSS, réglage indépendant.
            </p>
          </fieldset>

          <fieldset className="space-y-3 border-t-2 border-ink pt-4">
            <legend className="mb-1 font-display text-xs uppercase tracking-[0.2em]">
              Récupération RSS
            </legend>
            <label className="block space-y-1">
              <span className="font-display text-xs uppercase tracking-[0.15em] text-sepia">
                Intervalle de récupération
              </span>
              <select
                value={form.customFeedsIntervalMinutes}
                onChange={(e) => set("customFeedsIntervalMinutes", e.target.value)}
                className="w-full border border-ink/40 bg-paper px-3 py-2 font-serif text-sm focus:outline-none focus:ring-1 focus:ring-ink"
              >
                {CUSTOM_FEEDS_INTERVAL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-xs italic text-sepia">
              Un seul réglage pour DEUX choses : les flux ajoutés depuis « Catégories personnalisées »
              (/admin/categories, sans passer par FreshRSS), ET l’aspiration RSS de secours FreshRSS
              qui tourne toute seule quand le planning automatique est désactivé (mode manuel, bouton
              sur l’accueil) — plus de durée fixe séparée pour cette dernière, elle suit maintenant ce
              même intervalle. Aucun coût IA dans les deux cas : simple aspiration RSS, comme « Aspirer
              les news ».
            </p>
          </fieldset>

          <div className="flex flex-wrap items-center gap-x-8 gap-y-4 pt-2">
            <button
              onClick={save}
              disabled={saving}
              className="stamp-button stamp-bg-md inline-flex items-center justify-center px-4 font-display text-xs uppercase tracking-[0.2em] text-paper disabled:opacity-50"
            >
              {saving ? "Enregistrement..." : "Enregistrer"}
            </button>
            <button
              onClick={test}
              disabled={testing}
              className="stamp-button stamp-bg-md inline-flex items-center justify-center px-4 font-display text-xs uppercase tracking-[0.2em] text-paper disabled:opacity-50"
            >
              {testing ? "Test en cours..." : "Tester les réglages"}
            </button>
            {saveMessage && <span className="text-sm italic text-sepia">{saveMessage}</span>}
          </div>
        </div>
      )}
      <SpoonDivider />
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  // Les champs "password" (clés API, mot de passe FreshRSS) sont masqués par
  // défaut mais peuvent se révéler en clair — pratique pour relire une clé
  // déjà collée sans avoir à la retaper à l'aveugle.
  const [revealed, setRevealed] = useState(false);
  const isSecret = type === "password";

  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-[0.15em] text-neutral-600">{label}</span>
      <div className="flex gap-2">
        <input
          type={isSecret && revealed ? "text" : type}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="w-full border border-ink/40 bg-paper px-3 py-2 font-serif text-sm placeholder:italic placeholder:text-sepia/70 focus:outline-none focus:ring-1 focus:ring-ink"
        />
        {isSecret && (
          <button
            type="button"
            onClick={() => setRevealed((r) => !r)}
            className="shrink-0 border border-ink/40 px-3 py-2 text-xs uppercase tracking-[0.1em] text-ink transition-colors hover:bg-ink hover:text-paper"
          >
            {revealed ? "Masquer" : "Afficher"}
          </button>
        )}
      </div>
    </label>
  );
}
