/** Loupe façon "chercheur d'or"/western : manche façon corde tressée
 *  (hachures obliques) plutôt qu'un simple trait plein.
 *
 *  Extraite de DirectView pour être partagée avec le filtre des favoris —
 *  les deux champs de recherche de l'app doivent porter exactement la même
 *  icône, sans quoi le même geste (chercher) prendrait deux apparences. */
export function WesternMagnifier({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="10" cy="10" r="6.5" />
      <line x1="14.6" y1="14.6" x2="21" y2="21" strokeWidth="2.2" />
      <line x1="15.3" y1="15.9" x2="16.4" y2="14.8" strokeWidth="0.9" />
      <line x1="16.8" y1="17.4" x2="17.9" y2="16.3" strokeWidth="0.9" />
      <line x1="18.3" y1="18.9" x2="19.4" y2="17.8" strokeWidth="0.9" />
    </svg>
  );
}
