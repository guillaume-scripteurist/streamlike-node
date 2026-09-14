/**
 * Le chemin de LECTURE de Streamlike : les webservices `/ws/*`.
 *
 * Cette lib ne parlait jusqu'ici que l'API REST, y compris pour lire un
 * catalogue. C'est la mauvaise porte : l'API est faite pour écrire, elle n'est
 * pas dimensionnée pour une lecture par affichage de page, et la plateforme
 * bride les comptes qui s'en servent ainsi. Les webservices, eux, sont cachés,
 * rapides, et rendent en un appel ce que l'API demanderait en dix.
 *
 * ## Trois pièges, tous silencieux
 *
 * 1. **`page` est un DÉCALAGE, pas un numéro de page.** `pagesize=10&page=10`
 *    rend les éléments 10 à 19. Cette classe expose donc `offset`/`limit` et
 *    traduit — comme `listMedias` le fait déjà pour le `range` de l'API.
 * 2. **`sortorder` vaut `up` ou `down`**, jamais `asc`/`desc` : une mauvaise
 *    valeur répond 404. On accepte les deux vocabulaires et on traduit.
 * 3. **Une erreur, c'est un 404 en HTML**, pour un identifiant inconnu comme
 *    pour une IP non autorisée. {@link WebserviceError} porte l'indice.
 *
 * ## Où cette classe a le droit de tourner
 *
 * Sur un serveur. `company_id` adresse le catalogue ENTIER : il ne descend pas
 * dans un navigateur ni sur un téléphone. Seuls `media` et `rss` sont dispensés
 * de contrôle de référent et n'ont pas besoin de `company_id` — un front peut
 * les appeler directement, et ce sont les seuls.
 */
import { wsFetch, WebserviceError } from './http';
import {
  normalizeWsMedia,
  normalizeWsPlaylistPage,
  normalizeWsPlaylistSummary,
  unwrapWsList,
  wsNum,
  wsStr,
  type WsMedia,
  type WsPlaylistPage,
  type WsPlaylistSummary,
  type WsResume,
} from './ws-types';

/** Hôte des webservices ET du player. Service public, aucun jeton n'y transite. */
export const STREAMLIKE_CDN = 'https://cdn.streamlike.com';

export interface WebservicesConfig {
  /**
   * Identifiant de compte. **Secret** : il adresse tout le catalogue.
   * Facultatif — seuls les appels à l'échelle du compte l'exigent
   * (`playlists`, `languages`, `countries`, `vote`, version).
   */
  companyId?: string;
  /** Hôte de remplacement (recette, instance dédiée). */
  baseUrl?: string;
  /** `fetch` de remplacement — tests, proxy d'entreprise, cache. */
  fetch?: typeof fetch;
  /** Délai maximum par appel, en millisecondes. */
  timeoutMs?: number;
}

/** `up` / `down` côté plateforme ; `asc` / `desc` acceptés et traduits. */
export type SortOrder = 'up' | 'down' | 'asc' | 'desc';

/** Tris acceptés par `playlist` et `rss`. */
export type PlaylistOrderBy =
  | 'id' | 'name' | 'duration' | 'vote' | 'hit' | 'lastplaybackdate'
  | 'creationdate' | 'lastupdateddate' | 'lastupdatedfiledate' | 'releasedate' | 'position';

/** Champs sur lesquels `query` cherche. */
export type SearchField =
  | 'id' | 'name' | 'description' | 'credits' | 'keywords'
  | 'customs' | 'transcription' | 'permalink' | 'subtitle';

export interface PlaylistQuery {
  /** Une playlist, ou plusieurs : la réponse fusionne et `size` couvre l'union. */
  playlistId?: string | string[];
  viewId?: string;
  /** Tout le catalogue. À défaut, `companyId` de la configuration. */
  companyId?: string;
  /** Décalage dans la playlist (traduit en `page`). */
  offset?: number;
  /** Nombre d'éléments (traduit en `pagesize`). Défaut plateforme : 10. */
  limit?: number;
  orderBy?: PlaylistOrderBy;
  sortOrder?: SortOrder;
  /** Recherche plein texte. */
  query?: string;
  searchFields?: SearchField[];
  /** Code de langue. Ne pas forcer si les métadonnées ne sont pas traduites : le catalogue revient vide. */
  language?: string;
  country?: string;
  /** Ne garder que les médias dont l'encodage est terminé. */
  encoded?: boolean;
  /**
   * `true` : seulement les médias multi-pistes audio ; `false` : seulement les
   * mono-piste. Webservices 5.20 et au-delà — un serveur antérieur accepte le
   * paramètre et l'ignore, ce qui ne se voit pas dans la réponse.
   */
  multipleAudio?: boolean;
  /**
   * `1` ou `2` : ne garder que les médias publiés par cet encodeur
   * (webservices 5.20). Un média qui ne publie rien n'est rendu par aucune
   * des deux valeurs : `1` + `2` font moins que la liste non filtrée.
   */
  encodingVersion?: 1 | 2;
  /**
   * Ne garder que les médias classés dans au moins une playlist.
   *
   * Ce n'est PAS un ordre — cette lib l'a longtemps décrit comme « conserve
   * l'ordre manuel par-dessus le tri », ce qu'il n'a jamais fait. Inutile
   * avec `playlistId`, qui l'implique.
   *
   * Envoyé en `true`/`false`, jamais en `1`/`0` : avant les webservices 5.20 la
   * plateforme lisait les chiffres À L'ENVERS (`1` coupait le filtre), et un
   * appelant réglé « à l'essai » sur un ancien serveur obtient l'inverse sur le
   * nouveau. Les mots ont toujours voulu dire ce qu'ils disent.
   */
  forcePlaylist?: boolean;
  /**
   * Médias à exclure. Ils partent dans l'URL, une occurrence chacun, et le
   * service est en GET seul : au-delà de quelques dizaines d'identifiants,
   * filtrer côté appelant et demander une page un peu plus grande.
   */
  notMediaIds?: string[];
  notPlaylistIds?: string[];
  notViewIds?: string[];
  notLanguages?: string[];
  notCountries?: string[];
}

function normalizeSortOrder(value: SortOrder | undefined): 'up' | 'down' | undefined {
  if (!value) return undefined;
  if (value === 'asc' || value === 'up') return 'up';
  if (value === 'desc' || value === 'down') return 'down';
  return undefined;
}

/** Client des webservices `/ws/*`. Lecture seule, sauf `vote`. */
export class StreamlikeWebservices {
  private readonly baseUrl: string;

  constructor(private readonly config: WebservicesConfig = {}) {
    this.baseUrl = (config.baseUrl || STREAMLIKE_CDN).replace(/\/+$/, '');
  }

  /** URL d'un webservice, pour la journaliser, la mettre en cache ou la proxifier. */
  url(service: string, params: Record<string, unknown> | URLSearchParams = {}): string {
    const search = params instanceof URLSearchParams ? params : new URLSearchParams();
    if (!(params instanceof URLSearchParams)) {
      for (const [key, value] of Object.entries(params)) {
        if (value == null || value === '') continue;
        search.set(key, String(value));
      }
    }
    if (!search.has('f')) search.set('f', 'json');
    return `${this.baseUrl}/ws/${service}?${search.toString()}`;
  }

  private get(service: string, params: URLSearchParams): Promise<any> {
    if (!params.has('f')) params.set('f', 'json');
    return wsFetch(`${this.baseUrl}/ws/${service}?${params.toString()}`, service, {
      fetch: this.config.fetch,
      timeoutMs: this.config.timeoutMs,
    });
  }

  private requireCompanyId(explicit: string | undefined, service: string): string {
    const id = explicit || this.config.companyId;
    if (!id) {
      throw new WebserviceError(
        `ws/${service}`,
        null,
        `[ws/${service}] company_id manquant`,
        'Renseigner companyId à la construction, ou le passer à l\'appel. Il est SECRET : il ne descend ni dans un navigateur ni sur un téléphone.',
      );
    }
    return id;
  }

  // ---------------------------------------------------------------- médias

  /**
   * Tout ce que la plateforme sait d'un média, par identifiant ou par permalink.
   *
   * Dispensé de contrôle de référent : c'est l'un des deux seuls services
   * qu'un front peut appeler directement, avec `rss`.
   */
  async getMedia(ref: { mediaId?: string; permalink?: string }): Promise<WsMedia> {
    const params = new URLSearchParams();
    if (ref.mediaId) params.set('media_id', String(ref.mediaId));
    else if (ref.permalink) params.set('permalink', String(ref.permalink));
    else throw new WebserviceError('ws/media', null, '[ws/media] mediaId ou permalink requis');
    return normalizeWsMedia(await this.get('media', params));
  }

  /**
   * Une page de médias d'une playlist, d'une vue ou du compte entier.
   *
   * Ne PAS appeler `getMedia` pour chaque entrée de la liste : la réponse porte
   * déjà la même structure de média, complète. C'est la recommandation
   * explicite de la plateforme, et le premier motif de bridage d'un compte.
   */
  async getPlaylist(input: PlaylistQuery = {}): Promise<WsPlaylistPage> {
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const limit = Math.max(1, Math.floor(input.limit ?? 10));
    const params = new URLSearchParams();

    const playlistIds = Array.isArray(input.playlistId)
      ? input.playlistId.filter(Boolean).map(String)
      : (input.playlistId ? [String(input.playlistId)] : []);
    if (playlistIds.length === 1) params.set('playlist_id', playlistIds[0]);
    // Plusieurs playlists se demandent en répétant le paramètre. Le séparateur
    // `|` marche sur `videositemap`, pas ici — il rendrait un 404 muet.
    else for (const id of playlistIds) params.append('playlist_id[]', id);

    if (input.viewId) params.set('view_id', String(input.viewId));
    if (!playlistIds.length && !input.viewId) {
      params.set('company_id', this.requireCompanyId(input.companyId, 'playlist'));
    } else if (input.companyId) {
      params.set('company_id', String(input.companyId));
    }

    params.set('page', String(offset));
    params.set('pagesize', String(limit));
    if (input.orderBy) params.set('orderby', input.orderBy);
    const sort = normalizeSortOrder(input.sortOrder);
    if (sort) params.set('sortorder', sort);
    if (input.query) params.set('query', input.query);
    for (const field of input.searchFields || []) params.append('search_fields[]', field);
    if (input.language) params.set('lng', input.language);
    if (input.country) params.set('country', input.country);
    if (input.encoded != null) params.set('encoded', input.encoded ? '1' : '0');
    if (input.multipleAudio != null) params.set('multiple_audio', input.multipleAudio ? '1' : '0');
    if (input.encodingVersion != null) params.set('encoding_version', String(input.encodingVersion));
    if (input.forcePlaylist != null) params.set('forceplaylist', input.forcePlaylist ? 'true' : 'false');
    for (const id of input.notMediaIds || []) params.append('not_media_ids[]', String(id));
    for (const id of input.notPlaylistIds || []) params.append('not_playlist_ids[]', String(id));
    for (const id of input.notViewIds || []) params.append('not_view_ids[]', String(id));
    for (const l of input.notLanguages || []) params.append('not_languages[]', String(l));
    for (const c of input.notCountries || []) params.append('not_countries[]', String(c));

    return normalizeWsPlaylistPage(await this.get('playlist', params), { offset, limit });
  }

  /**
   * Parcourt une playlist entière, page après page.
   *
   * S'arrête sur `metadata.size` plutôt que sur une page vide : demander une
   * page de trop à chaque parcours est exactement le genre d'appel que la
   * plateforme compte. Le plafond de pages protège d'un `size` fantaisiste qui
   * ferait tourner la boucle indéfiniment sur le chemin d'une requête HTTP.
   */
  async *iteratePlaylist(
    input: PlaylistQuery & { pageSize?: number; maxPages?: number } = {},
  ): AsyncGenerator<WsMedia, void, undefined> {
    const limit = Math.max(1, Math.floor(input.pageSize ?? input.limit ?? 50));
    const maxPages = Math.max(1, Math.floor(input.maxPages ?? 100));
    let offset = Math.max(0, Math.floor(input.offset ?? 0));
    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.getPlaylist({ ...input, offset, limit });
      for (const media of result.medias) yield media;
      if (result.nextOffset == null) return;
      offset = result.nextOffset;
    }
  }

  /** Rassemble tout un parcours en mémoire. À réserver aux catalogues bornés. */
  async listAllMedias(input: PlaylistQuery & { pageSize?: number; maxPages?: number } = {}): Promise<WsMedia[]> {
    const out: WsMedia[] = [];
    for await (const media of this.iteratePlaylist(input)) out.push(media);
    return out;
  }

  /**
   * Médias partageant au moins un mot-clé avec celui-ci.
   *
   * Vide quand le média ne porte aucun mot-clé — cas fréquent sur les
   * catalogues où personne n'a jamais rempli ce champ. Ce n'est pas une panne.
   */
  async getRelated(input: { mediaId: string; viewId?: string; offset?: number; limit?: number }): Promise<WsMedia[]> {
    const params = new URLSearchParams({ media_id: String(input.mediaId) });
    if (input.viewId) params.set('view_id', String(input.viewId));
    if (input.offset != null) params.set('page', String(Math.max(0, Math.floor(input.offset))));
    if (input.limit != null) params.set('pagesize', String(Math.max(1, Math.floor(input.limit))));
    const body = await this.get('related', params);
    const rows = body?.related?.medias ?? body?.playlist?.medias ?? body?.medias;
    return unwrapWsList(rows, 'media').map(m => normalizeWsMedia({ media: m }));
  }

  // ------------------------------------------------------------- playlists

  /** Les playlists en ligne du compte, ou celles d'une vue. */
  async listPlaylists(input: {
    companyId?: string;
    viewId?: string;
    offset?: number;
    limit?: number;
    orderBy?: 'id' | 'name' | 'creationdate' | 'position';
    sortOrder?: SortOrder;
  } = {}): Promise<WsPlaylistSummary[]> {
    const params = new URLSearchParams({
      company_id: this.requireCompanyId(input.companyId, 'playlists'),
    });
    if (input.viewId) params.set('view_id', String(input.viewId));
    if (input.offset != null) params.set('page', String(Math.max(0, Math.floor(input.offset))));
    if (input.limit != null) params.set('pagesize', String(Math.max(1, Math.floor(input.limit))));
    if (input.orderBy) params.set('orderby', input.orderBy);
    const sort = normalizeSortOrder(input.sortOrder);
    if (sort) params.set('sortorder', sort);
    const body = await this.get('playlists', params);
    const rows = body?.playlists?.playlist ?? body?.playlists ?? body;
    return unwrapWsList(Array.isArray(rows) ? rows : [], 'playlist').map(normalizeWsPlaylistSummary);
  }

  // -------------------------------------------------------- lecture, votes

  /**
   * Dernière position vue par un spectateur sur un média.
   *
   * N'a de valeur que si le MÊME `user_token` a été passé au player : c'est lui
   * qui fait enregistrer les positions. Sans cela le service répond, mais
   * toujours 0 — un « reprendre la lecture » qui ramène systématiquement au
   * début vient presque toujours de là.
   */
  async getResume(input: { mediaId: string; userToken: string }): Promise<WsResume> {
    const body = await this.get('resume', new URLSearchParams({
      media_id: String(input.mediaId),
      user_token: String(input.userToken),
    }));
    const node = body?.resume ?? body ?? {};
    return {
      mediaId: wsStr(node.media_id) || String(input.mediaId),
      positionSec: wsNum(node.position ?? node.timecode ?? node.resume),
      raw: node,
    };
  }

  /** Nombre de lectures en cours sur un média — badge « en direct », bandeau « tendance ». */
  async getNowPlaying(mediaId: string): Promise<number> {
    const body = await this.get('nowplaying', new URLSearchParams({ media_id: String(mediaId) }));
    const node = body?.nowplaying ?? body ?? {};
    return wsNum(typeof node === 'number' ? node : (node.count ?? node.nowplaying ?? node.value));
  }

  /**
   * Enregistre une note de 0 à 5.
   *
   * Deux contraintes que la plateforme ne lèvera pas : l'IP appelante doit être
   * autorisée (et **cette protection-là ne peut pas être désactivée**), et la
   * déduplication est à notre charge. La plateforme ne stocke qu'un agrégat :
   * « qui a voté quoi » appartient à notre base, et c'est elle qu'il faut
   * interroger AVANT d'appeler, sans quoi un seul enthousiaste déplace la
   * moyenne à lui tout seul.
   */
  async vote(input: { mediaId: string; value: number; companyId?: string }): Promise<any> {
    const value = Math.max(0, Math.min(5, Math.round(input.value)));
    return this.get('vote', new URLSearchParams({
      company_id: this.requireCompanyId(input.companyId, 'vote'),
      media_id: String(input.mediaId),
      value: String(value),
    }));
  }

  /**
   * Description complète des fichiers encodés d'un média.
   *
   * **Exige une IP autorisée.** L'URL de manifeste rendue par
   * {@link getMedia} (`manifestUrl`) porte la même information sans cette
   * contrainte : c'est presque toujours la bonne voie.
   */
  async getManifest(mediaId: string, token?: string): Promise<any> {
    const params = new URLSearchParams({ media_id: String(mediaId) });
    if (token) params.set('token', token);
    return this.get('manifest', params);
  }

  // -------------------------------------------------------------- annexes

  /** Langues présentes dans le catalogue en ligne. */
  async listLanguages(input: { companyId?: string; viewId?: string } = {}): Promise<string[]> {
    const params = new URLSearchParams({ company_id: this.requireCompanyId(input.companyId, 'languages') });
    if (input.viewId) params.set('view_id', String(input.viewId));
    const body = await this.get('languages', params);
    const rows = body?.languages?.language ?? body?.languages ?? body;
    return unwrapWsList(Array.isArray(rows) ? rows : [], 'language')
      .map(l => (typeof l === 'string' ? l : wsStr(l?.language_id ?? l?.id)))
      .filter(Boolean);
  }

  /** Pays rattachés au catalogue en ligne. */
  async listCountries(input: { companyId?: string; viewId?: string } = {}): Promise<string[]> {
    const params = new URLSearchParams({ company_id: this.requireCompanyId(input.companyId, 'countries') });
    if (input.viewId) params.set('view_id', String(input.viewId));
    const body = await this.get('countries', params);
    const rows = body?.countries?.country ?? body?.countries ?? body;
    return unwrapWsList(Array.isArray(rows) ? rows : [], 'country')
      .map(c => (typeof c === 'string' ? c : wsStr(c?.country_id ?? c?.id)))
      .filter(Boolean);
  }

  /** Version de la plateforme — utile pour savoir si un paramètre récent existe. */
  async getVersion(companyId?: string): Promise<string> {
    const body = await this.get('getStreamlikeVersion', new URLSearchParams({
      company_id: this.requireCompanyId(companyId, 'getStreamlikeVersion'),
    }));
    return wsStr(body?.version ?? body?.getStreamlikeVersion ?? body);
  }
}
