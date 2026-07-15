"use client";

import { useEffect, useState } from "react";

type SettingsForm = {
  freshrssBaseUrl: string;
  freshrssUsername: string;
  freshrssApiPassword: string;
  anthropicApiKey: string;
  anthropicModel: string;
  editionHour: string;
  editionMinute: string;
  editionTz: string;
};

const EMPTY: SettingsForm = {
  freshrssBaseUrl: "",
  freshrssUsername: "",
  freshrssApiPassword: "",
  anthropicApiKey: "",
  anthropicModel: "",
  editionHour: "",
  editionMinute: "",
  editionTz: ""
};

type TestResult = { ok: boolean; message: string };

export default function AdminSettingsPage() {
  const [form, setForm] = useState<SettingsForm>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<{ freshrss?: TestResult; anthropic?: TestResult } | null>(
    null
  );

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
          editionHour: s.editionHour?.toString() ?? "",
          editionMinute: s.editionMinute?.toString() ?? "",
          editionTz: s.editionTz || ""
        });
      })
      .finally(() => setLoading(false));
  }, []);

  function set<K extends keyof SettingsForm>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function payload() {
    return {
      freshrssBaseUrl: form.freshrssBaseUrl,
      freshrssUsername: form.freshrssUsername,
      freshrssApiPassword: form.freshrssApiPassword,
      anthropicApiKey: form.anthropicApiKey,
      anthropicModel: form.anthropicModel,
      editionHour: form.editionHour === "" ? null : Number(form.editionHour),
      editionMinute: form.editionMinute === "" ? null : Number(form.editionMinute),
      editionTz: form.editionTz
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
    <main className="mx-auto max-w-2xl px-6 py-10">
      <div className="mb-8 text-center">
        <a href="/" className="font-masthead text-5xl">
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
            <legend className="mb-1 font-display text-xs uppercase tracking-[0.2em]">IA (Anthropic)</legend>
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
          </fieldset>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              onClick={save}
              disabled={saving}
              className="border-2 border-ink bg-ink px-4 py-2 font-display text-xs uppercase tracking-[0.2em] text-paper transition-colors hover:bg-paper hover:text-ink disabled:opacity-50"
            >
              {saving ? "Enregistrement..." : "Enregistrer"}
            </button>
            <button
              onClick={test}
              disabled={testing}
              className="border-2 border-ink bg-paper px-4 py-2 font-display text-xs uppercase tracking-[0.2em] text-ink transition-colors hover:bg-ink hover:text-paper disabled:opacity-50"
            >
              {testing ? "Test en cours..." : "Tester les réglages"}
            </button>
            {saveMessage && <span className="text-sm italic text-sepia">{saveMessage}</span>}
          </div>
        </div>
      )}
      <p className="mt-14 text-center text-xl tracking-[0.5em] text-sepia">❦ ❦ ❦</p>
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
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-[0.15em] text-neutral-600">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-neutral-400 bg-paper px-3 py-2 text-sm"
      />
    </label>
  );
}
