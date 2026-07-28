import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";

async function assertAuthed(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return isValidSessionToken(token);
}

// Liste les modèles Gemini réellement disponibles pour la clé API donnée,
// récupérée en direct chez Google (endpoint /v1beta/models — metadata,
// gratuit, ne consomme aucun token) plutôt qu'une liste codée en dur ici :
// si Google ajoute/retire un modèle, la liste affichée dans /admin/settings
// suit automatiquement, sans avoir à redéployer l'app.
//
// La clé passe dans le corps de la requête (POST), jamais dans l'URL, même
// vers notre propre API — pas de secret dans une query string.
export async function POST(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { apiKey } = await req.json().catch(() => ({}));
  if (!apiKey) {
    return NextResponse.json({ error: "Clé API Gemini requise pour lister les modèles." }, { status: 400 });
  }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
    );

    if (res.status === 400 || res.status === 403) {
      return NextResponse.json({ error: "Clé Gemini invalide ou refusée." }, { status: 401 });
    }
    if (!res.ok) {
      return NextResponse.json({ error: `Échec (${res.status} ${res.statusText}).` }, { status: 502 });
    }

    const data: any = await res.json();

    // Seuls les modèles qui savent générer du texte (pas ceux réservés à
    // l'embedding, par exemple) ont leur place dans ce sélecteur.
    const models = (data.models || [])
      .filter((m: any) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m: any) => ({
        id: (m.name || "").replace(/^models\//, ""),
        displayName: m.displayName || (m.name || "").replace(/^models\//, "")
      }))
      .sort((a: { displayName: string }, b: { displayName: string }) => a.displayName.localeCompare(b.displayName));

    return NextResponse.json({ models });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Erreur réseau vers l'API Gemini." }, { status: 502 });
  }
}
