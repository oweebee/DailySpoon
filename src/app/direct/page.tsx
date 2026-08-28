import { redirect } from "next/navigation";

/**
 * "En direct" est devenu la page d'accueil (voir src/app/page.tsx). Cette
 * adresse est conservée en simple redirection : elle a été la page
 * quotidienne pendant toute la vie du projet avant la V1, elle traîne donc
 * dans les favoris du navigateur, les raccourcis d'écran d'accueil et
 * l'historique. La supprimer sèchement aurait renvoyé une 404 à chacun d'eux.
 */
export default function DirectRedirectPage() {
  redirect("/");
}
