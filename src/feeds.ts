/**
 * Flux et emballages : mRSS, podcast, sitemap vidéo, QR.
 *
 * Ce sont des URL, pas des appels : on les construit, on les publie, la
 * plateforme les sert. Les écrire à la main est sans risque… jusqu'au jour où
 * l'une part avec `playlist_id[]=a&playlist_id[]=b` — la forme du `playlist`,
 * qui ne vaut rien ici : `videositemap` attend `a|b`. Le flux revient vide, et
 * rien ne signale l'erreur.
 */
import { STREAMLIKE_CDN } from './webservices';

export interface FeedBase {
  /** Hôte de remplacement. */
  baseUrl?: string;
  /**
   * Profil WebTV : il porte les URL de base de VOS pages média et playlist.
   * Sans lui, les liens du flux pointent vers le player Streamlike — ce qui
   * n'est presque jamais ce qu'on veut dans un sitemap.
   */
  profileId?: string;
}

function base(input: FeedBase): string {
  return (input.baseUrl || STREAMLIKE_CDN).replace(/\/+$/, '');
}

export interface RssOptions extends FeedBase {
  playlistId?: string;
  companyId?: string;
  language?: string;
  query?: string;
  orderBy?: string;
  sortOrder?: 'up' | 'down';
  offset?: number;
  limit?: number;
}

/**
 * URL d'un flux mRSS 2.0. Ne contient que les médias EN LIGNE.
 *
 * Dispensé de contrôle de référent, comme `/ws/media` : c'est le seul flux
 * qu'un front peut aller chercher lui-même.
 */
export function rssUrl(input: RssOptions): string {
  const params = new URLSearchParams();
  if (input.playlistId) params.set('playlist_id', input.playlistId);
  if (input.companyId) params.set('company_id', input.companyId);
  if (input.language) params.set('lng', input.language);
  if (input.query) params.set('query', input.query);
  if (input.orderBy) params.set('orderby', input.orderBy);
  if (input.sortOrder) params.set('sortorder', input.sortOrder);
  if (input.offset != null) params.set('page', String(Math.max(0, Math.floor(input.offset))));
  if (input.limit != null) params.set('pagesize', String(Math.max(1, Math.floor(input.limit))));
  if (input.profileId) params.set('profile_id', input.profileId);
  return `${base(input)}/ws/rss?${params.toString()}`;
}

/**
 * URL d'un flux podcast.
 *
 * **Seuls `playlist_id`, `lng` et `orderby` s'appliquent** : passer `pagesize`
 * ou `query` ici ne produit pas d'erreur, ça n'a simplement aucun effet. Les
 * métadonnées du podcast (nom, auteur, catégorie, jaquette) viennent de la
 * plateforme, playlist par playlist, et remontent dans `/ws/playlists`.
 */
export function podcastUrl(input: FeedBase & {
  playlistId: string;
  language?: string;
  orderBy?: string;
}): string {
  const params = new URLSearchParams({ playlist_id: input.playlistId });
  if (input.language) params.set('lng', input.language);
  if (input.orderBy) params.set('orderby', input.orderBy);
  return `${base(input)}/ws/podcast?${params.toString()}`;
}

/**
 * URL d'un sitemap vidéo Google.
 *
 * Plusieurs playlists se joignent par `|` — et **uniquement ici**. À
 * régénérer à chaque publication : un sitemap n'a d'intérêt que tant qu'il
 * décrit le site.
 */
export function videoSitemapUrl(input: FeedBase & {
  playlistIds?: string[];
  companyId?: string;
  /** Omet l'URL du fichier lui-même, quand on ne veut pas l'exposer. */
  noContentLoc?: boolean;
}): string {
  const params = new URLSearchParams();
  const ids = (input.playlistIds || []).filter(Boolean);
  if (ids.length) params.set('playlist_id', ids.join('|'));
  if (input.companyId) params.set('company_id', input.companyId);
  if (input.profileId) params.set('profile_id', input.profileId);
  if (input.noContentLoc) params.set('no_content_loc', '1');
  return `${base(input)}/ws/videositemap?${params.toString()}`;
}

/** URL du service QR. Voir {@link fetchQrImageUrl} : il ne rend PAS l'image. */
export function qrUrl(input: FeedBase & {
  mediaId: string;
  /** Taille d'un module du QR. */
  size?: number;
  /** Niveau de correction d'erreur : `L`, `M`, `Q`, `H`. */
  level?: 'L' | 'M' | 'Q' | 'H';
}): string {
  const params = new URLSearchParams({ media_id: input.mediaId });
  if (input.size != null) params.set('size', String(input.size));
  if (input.level) params.set('level', input.level);
  return `${base(input)}/ws/qr?${params.toString()}`;
}

/**
 * Adresse du PNG du QR code.
 *
 * Le service `qr` ne rend pas l'image malgré son nom : il rend une balise
 * `<img>` HTML pointant vers un PNG du CDN. Poser l'URL du service dans un
 * `src` affiche donc une image cassée. On extrait le `src`, une fois ; le PNG
 * est stable et se met en cache.
 */
export async function fetchQrImageUrl(
  input: FeedBase & { mediaId: string; size?: number; level?: 'L' | 'M' | 'Q' | 'H' },
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<string | null> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const res = await doFetch(qrUrl(input), { method: 'GET' });
  if (!res.ok) return null;
  const html = await res.text();
  const match = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  if (!match) return null;
  // Les URL du CDN sont parfois relatives au protocole (`//cfcdn…`) : laissées
  // telles quelles, elles cassent une page servie en https depuis un contexte
  // qui ne les résout pas (un e-mail, un PDF, un rendu serveur).
  return match[1].startsWith('//') ? `https:${match[1]}` : match[1];
}
