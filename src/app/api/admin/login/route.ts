import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  isCorrectPassword,
  isPasswordConfigured,
  sessionTokenForPassword
} from "@/lib/auth";

export async function POST(req: NextRequest) {
  const { password } = await req.json().catch(() => ({ password: "" }));

  // Sans ADMIN_PASSWORD, une instance en production est volontairement
  // FERMÉE plutôt qu'ouverte (voir src/lib/auth.ts). Le dire explicitement :
  // "mot de passe incorrect" enverrait chercher pendant des heures un mot de
  // passe qui n'existe pas, alors que le problème est une variable
  // d'environnement manquante côté serveur.
  if (!isPasswordConfigured() && process.env.NODE_ENV === "production") {
    return NextResponse.json(
      {
        error:
          "Aucun mot de passe n'est configuré sur ce serveur : renseigne la variable d'environnement ADMIN_PASSWORD, puis redéploie."
      },
      { status: 503 }
    );
  }

  if (!isCorrectPassword(password || "")) {
    return NextResponse.json({ error: "Mot de passe incorrect" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await sessionTokenForPassword(password || ""), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30
  });
  return res;
}
