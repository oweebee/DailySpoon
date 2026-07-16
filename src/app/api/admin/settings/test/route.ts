import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";

async function assertAuthed(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return isValidSessionToken(token);
}

type TestResult = { ok: boolean; message: string };

// Tests the values currently typed in the admin form — NOT what's saved in
// the DB/env — so the user can check before hitting "Enregistrer".
export async function POST(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const {
    freshrssBaseUrl,
    freshrssUsername,
    freshrssApiPassword,
    anthropicApiKey,
    anthropicModel,
    geminiApiKey,
    geminiModel
  } = body ?? {};

  const results: { freshrss?: TestResult; anthropic?: TestResult; gemini?: TestResult } = {};

  if (freshrssBaseUrl && freshrssUsername && freshrssApiPassword) {
    results.freshrss = await testFreshRss(freshrssBaseUrl, freshrssUsername, freshrssApiPassword);
  } else {
    results.freshrss = { ok: false, message: "URL, identifiant et mot de passe requis pour tester." };
  }

  // Les deux clés sont testées indépendamment du fournisseur actuellement
  // sélectionné — pratique pour valider une clé avant de basculer dessus.
  if (anthropicApiKey) {
    results.anthropic = await testAnthropic(anthropicApiKey, anthropicModel);
  }
  if (geminiApiKey) {
    results.gemini = await testGemini(geminiApiKey, geminiModel);
  }

  return NextResponse.json(results);
}

async function testFreshRss(baseUrlRaw: string, username: string, password: string): Promise<TestResult> {
  const baseUrl = baseUrlRaw.replace(/\/+$/, "");
  try {
    const res = await fetch(`${baseUrl}/api/greader.php/accounts/ClientLogin`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ Email: username, Passwd: password }).toString()
    });

    if (!res.ok) {
      return {
        ok: false,
        message: `Échec (${res.status} ${res.statusText}) — vérifie l'URL et les identifiants.`
      };
    }

    const text = await res.text();
    const hasAuth = text.split("\n").some((line) => line.startsWith("Auth="));
    if (!hasAuth) {
      return { ok: false, message: "FreshRSS a répondu mais sans jeton d'authentification — identifiants incorrects." };
    }

    return { ok: true, message: "Connexion FreshRSS réussie." };
  } catch (err: any) {
    return { ok: false, message: `Impossible de joindre ${baseUrl} : ${err?.message || "erreur réseau"}` };
  }
}

// Règle du projet : on évite de consommer des tokens quand ce n'est pas
// nécessaire. On appelle directement l'API REST /v1/models (metadata, pas de
// génération) au lieu du SDK — la version du SDK installée n'expose pas de
// ressource `models`, alors que l'endpoint HTTP existe côté API. Coût nul.
async function testAnthropic(apiKey: string, model?: string): Promise<TestResult> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      }
    });

    if (res.status === 401) {
      return { ok: false, message: "Clé Anthropic invalide (401 non autorisé)." };
    }
    if (!res.ok) {
      return { ok: false, message: `Échec (${res.status} ${res.statusText}) en vérifiant la clé Anthropic.` };
    }

    const data = await res.json();
    const models: string[] = (data.data || []).map((m: any) => m.id);

    if (model && !models.includes(model)) {
      return {
        ok: true,
        message: `Clé Anthropic valide, mais le modèle "${model}" n'apparaît pas dans la liste des modèles disponibles pour ce compte — vérifie l'orthographe.`
      };
    }

    return { ok: true, message: "Clé Anthropic valide (vérifiée sans consommer de tokens)." };
  } catch (err: any) {
    return { ok: false, message: `Impossible de joindre l'API Anthropic : ${err?.message || "erreur réseau"}` };
  }
}

// Même principe que testAnthropic : /v1beta/models liste les modèles
// disponibles pour la clé sans lancer de génération, donc coût nul.
async function testGemini(apiKey: string, model?: string): Promise<TestResult> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
    );

    if (res.status === 400 || res.status === 403) {
      return { ok: false, message: "Clé Gemini invalide ou refusée." };
    }
    if (!res.ok) {
      return { ok: false, message: `Échec (${res.status} ${res.statusText}) en vérifiant la clé Gemini.` };
    }

    const data: any = await res.json();
    const models: string[] = (data.models || []).map((m: any) => (m.name || "").replace(/^models\//, ""));

    if (model && !models.includes(model)) {
      return {
        ok: true,
        message: `Clé Gemini valide, mais le modèle "${model}" n'apparaît pas dans la liste des modèles disponibles pour ce compte — vérifie l'orthographe.`
      };
    }

    return { ok: true, message: "Clé Gemini valide (vérifiée sans consommer de tokens)." };
  } catch (err: any) {
    return { ok: false, message: `Impossible de joindre l'API Gemini : ${err?.message || "erreur réseau"}` };
  }
}
