import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";
import { testWallabagConnection } from "@/lib/wallabagSend";

async function assertAuthed(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return isValidSessionToken(token);
}

// Teste la connexion Wallabag depuis /admin/settings : tente juste d'obtenir
// un token OAuth2 (password grant), SANS envoyer d'article. Teste les valeurs
// du FORMULAIRE (pas forcément déjà enregistrées), comme le reste des tests de
// /admin/settings.
export async function POST(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { wallabagBaseUrl, wallabagClientId, wallabagClientSecret, wallabagUsername, wallabagPassword } =
    body as {
      wallabagBaseUrl?: string;
      wallabagClientId?: string;
      wallabagClientSecret?: string;
      wallabagUsername?: string;
      wallabagPassword?: string;
    };

  if (!wallabagBaseUrl || !wallabagClientId || !wallabagClientSecret || !wallabagUsername || !wallabagPassword) {
    return NextResponse.json(
      { error: "URL de l'instance, client id, client secret, identifiant et mot de passe requis." },
      { status: 400 }
    );
  }

  const result = await testWallabagConnection({
    baseUrl: wallabagBaseUrl.replace(/\/+$/, ""),
    clientId: wallabagClientId,
    clientSecret: wallabagClientSecret,
    username: wallabagUsername,
    password: wallabagPassword
  });

  return NextResponse.json(result);
}
