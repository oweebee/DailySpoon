"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// useSearchParams() must live inside a <Suspense> boundary, otherwise
// `next build` fails while prerendering /admin/login
// (https://nextjs.org/docs/messages/missing-suspense-with-csr-bailout).
function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    setLoading(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error || "Erreur de connexion");
      return;
    }
    router.push(params.get("next") || "/");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <input
        type="password"
        placeholder="Mot de passe"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="w-full border border-ink bg-paper px-3 py-2 text-center font-serif placeholder:italic placeholder:text-sepia focus:outline-none focus:ring-1 focus:ring-ink"
        autoFocus
      />
      {error && <p className="text-center text-sm italic text-journal">{error}</p>}
      <button
        type="submit"
        disabled={loading}
        className="w-full border-2 border-ink bg-ink px-3 py-2 font-display text-sm uppercase tracking-[0.25em] text-paper transition-colors hover:bg-paper hover:text-ink disabled:opacity-50"
      >
        {loading ? "Connexion..." : "Se connecter"}
      </button>
    </form>
  );
}

export default function AdminLoginPage() {
  return (
    <main className="mx-auto max-w-md px-6 py-24">
      {/* Masthead miniature */}
      <div className="mb-8 text-center">
        <p className="font-masthead text-6xl">DailySpoon</p>
        <div className="double-rule mt-4" />
        <p className="py-1.5 text-[0.65rem] uppercase tracking-[0.3em] text-sepia">
          Édition quotidienne personnelle
        </p>
        <div className="double-rule rotate-180" />
      </div>

      <h1 className="mb-6 text-center font-display text-xl font-bold uppercase tracking-[0.2em]">
        Connexion DailySpoon
      </h1>
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
      <p className="mt-10 text-center text-xl tracking-[0.5em] text-sepia">❦</p>
    </main>
  );
}
