/**
 * « Ce média va-t-il se lire dans une simple iframe ? »
 *
 * Un catalogue n'est jamais entièrement lisible : certains médias sont protégés
 * par jeton, par mot de passe, par IP ou par domaine référent. Poser l'iframe
 * quand même donne un rectangle noir, et personne dans la salle ne saura dire
 * si c'est le réseau, le player ou la vidéo.
 *
 * Les trois drapeaux (`is_tokenized`, `has_password`, `is_secured`) arrivent
 * déjà dans `/ws/media` ET dans `/ws/playlist` : la question se tranche donc
 * sans un seul appel supplémentaire, au moment où on construit la liste.
 */

/** Ce que la protection d'un média impose à l'intégration. */
export type Playability =
  /** Rien à faire : l'URL du player suffit. */
  | 'open'
  /** Le player réclamera le mot de passe lui-même — poser l'iframe normalement. */
  | 'password'
  /**
   * Restreint par IP ou par référent : la lecture dépend du spectateur, pas de
   * nous. Poser l'iframe et ne signaler qu'en cas d'échec réel.
   */
  | 'restricted'
  /**
   * Il faut un `sltoken` frais, signé par le serveur. Une URL nue ne lira pas.
   */
  | 'token-required';

/** Les seuls champs nécessaires — n'importe quel média normalisé les porte. */
export interface PlayabilityFlags {
  isTokenized?: boolean;
  hasPassword?: boolean;
  isSecured?: boolean;
}

/**
 * Classe un média selon sa protection.
 *
 * L'ordre des tests n'est pas indifférent : un média à la fois protégé par
 * jeton ET par mot de passe se lit avec le mot de passe, le player s'en
 * chargeant. Tester le jeton d'abord le déclarerait injouable à tort et
 * retirerait du catalogue un média qui se serait très bien lu.
 */
export function playability(media: PlayabilityFlags): Playability {
  if (media.hasPassword) return 'password';
  if (media.isTokenized) return 'token-required';
  if (media.isSecured) return 'restricted';
  return 'open';
}

/**
 * Peut-on poser l'iframe sans autre précaution ?
 *
 * Vrai pour tout sauf `token-required` : le mot de passe et les restrictions
 * d'IP se règlent entre le player et le spectateur.
 */
export function isEmbeddable(media: PlayabilityFlags): boolean {
  return playability(media) !== 'token-required';
}

/**
 * Filtre une liste sur ce qui se lira réellement.
 *
 * `withToken` : mettre `true` quand l'appelant sait signer un `sltoken` pour
 * chaque média — les médias à jeton sont alors conservés.
 */
export function playableOnly<T extends PlayabilityFlags>(
  medias: readonly T[],
  options: { withToken?: boolean } = {},
): T[] {
  return medias.filter(m => (options.withToken ? true : isEmbeddable(m)));
}
