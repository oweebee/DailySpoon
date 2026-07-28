"use client";

import { useEffect } from "react";

/**
 * Enregistre le service worker (voir public/sw.js) — condition requise par
 * les navigateurs pour proposer l'installation en PWA ("Ajouter à l'écran
 * d'accueil"), en plus du manifest.json déjà référencé dans les metadata.
 * Échec silencieux si non supporté (vieux navigateur, contexte non
 * sécurisé...) : l'app fonctionne normalement dans tous les cas, la PWA est
 * un bonus.
 */
export function PwaRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  return null;
}
