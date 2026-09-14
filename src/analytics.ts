/**
 * Audience : ce qu'il faut émettre quand on ne joue PAS avec le player
 * Streamlike, et ce qu'on peut relire côté serveur.
 *
 * Le player de la plateforme rapporte tout seul. Un player natif (ExoPlayer,
 * AVPlayer, `<video>` maison) ne rapporte **rien**. C'est la première cause de
 * « la console dit que personne ne regarde nos vidéos » : le trafic apparaît
 * bien dans la consommation, les lectures nulle part.
 *
 * Deux balises, deux mesures différentes — ne pas les confondre :
 *   - `o.k`   : UNE lecture. À tirer une fois, au premier `playing`.
 *   - `eng.k` : les SEGMENTS réellement vus. À tirer régulièrement, et à
 *               chaque saut, parce qu'un saut termine un segment et en ouvre
 *               un autre.
 *
 * Ce module ne fait aucun appel : il rend des URL. C'est délibéré — le tir
 * revient au player, qui seul sait quand il joue, et un `sendBeacon` côté
 * navigateur survit à une fermeture d'onglet là où un `fetch` est coupé.
 */
import { apiFetch } from './http';
import { STREAMLIKE_CDN } from './webservices';

export type StreamType = 'hls' | 'mp4' | 'mp3' | 'aac' | 'webm';

export interface PlaybackBeaconInput {
  mediaId: string;
  /** Type de flux réellement joué. */
  streamType?: StreamType;
  /** Nom de VOTRE player, pour distinguer les sources dans la console. */
  playerName?: string;
  /** Anti-cache. Rempli tout seul si absent. */
  timestamp?: number;
  baseUrl?: string;
}

/**
 * URL de comptage d'UNE lecture.
 *
 * Chaque appel compte une vue : la tirer au montage du composant, ou à chaque
 * `playing` (qui se déclenche aussi après une pause), gonfle les chiffres. Une
 * fois par lecture, puis on se débranche.
 */
export function playbackBeaconUrl(input: PlaybackBeaconInput): string {
  const base = (input.baseUrl || STREAMLIKE_CDN).replace(/\/+$/, '');
  const params = new URLSearchParams({
    m: String(input.mediaId),
    t: String(input.timestamp ?? Date.now()),
  });
  if (input.streamType) params.set('s', input.streamType);
  if (input.playerName) params.set('p', input.playerName);
  return `${base}/o.k?${params.toString()}`;
}

export interface EngagementBeaconInput {
  mediaId: string;
  /** Durée TOTALE du média, en secondes. */
  durationSec: number;
  streamType: StreamType;
  /** Hauteur de l'image jouée, en pixels. */
  qualityHeight: number;
  playerName: string;
  /** Début du segment vu, en secondes. */
  fromSec: number;
  /** Fin du segment vu, en secondes. */
  toSec: number;
  /** Horodatage client à la fin du segment, en secondes POSIX. */
  timestamp?: number;
  /** Identifiant de session, unique par affichage du player. */
  sessionId?: string;
  /** Le MÊME identifiant de spectateur que le `user_token` du player. */
  userToken?: string;
  fingerprint?: string;
  baseUrl?: string;
}

/**
 * URL de report d'un SEGMENT vu.
 *
 * Les segments qui se chevauchent sont normaux et attendus : c'est ce qui rend
 * les replays visibles, et c'est pourquoi l'engagement peut dépasser 1.
 * On borne quand même `rs`/`re` : la plateforme rejette un segment qui sort de
 * la durée, et le rejet ne se voit pas — la balise est un GET dont personne ne
 * lit la réponse.
 */
export function engagementBeaconUrl(input: EngagementBeaconInput): string {
  const base = (input.baseUrl || STREAMLIKE_CDN).replace(/\/+$/, '');
  const duration = Math.max(0, Number(input.durationSec) || 0);
  const from = Math.min(Math.max(0, Number(input.fromSec) || 0), duration);
  const to = Math.min(Math.max(from, Number(input.toSec) || 0), duration);
  const params = new URLSearchParams({
    m: String(input.mediaId),
    d: String(Math.round(duration)),
    t: input.streamType,
    q: String(Math.round(input.qualityHeight)),
    p: input.playerName,
    ts: String(input.timestamp ?? Math.floor(Date.now() / 1000)),
    rs: String(from),
    re: String(to),
  });
  if (input.sessionId) params.set('s', input.sessionId);
  if (input.userToken) params.set('u', input.userToken);
  if (input.fingerprint) params.set('f', input.fingerprint);
  return `${base}/eng.k?${params.toString()}`;
}

/** Un segment vu vaut-il la peine d'être rapporté ? */
export function isReportableSegment(fromSec: number, toSec: number): boolean {
  // Un segment nul ou négatif arrive à chaque saut en arrière et à chaque
  // pause immédiate. Le rapporter ajoute du bruit sans rien mesurer.
  return Number.isFinite(fromSec) && Number.isFinite(toSec) && toSec - fromSec >= 0.5;
}

/**
 * Un rapport d'analyse VIDE est le tableau `[]`, pas un objet.
 *
 * `response.data[companyId]` jette donc sur une période sans lecture, et
 * `Object.keys` rend `[]` pour les deux formes — d'où ce test explicite. Les
 * autres habitudes des rapports : les CLÉS sont les valeurs (on itère sur des
 * identifiants de compte, des dates, des codes pays) ; un trou est une clé
 * absente, jamais un `0` ; et `aggregation` change la forme, pas seulement le
 * regroupement.
 */
export function isEmptyReport(body: unknown): boolean {
  const data = body && typeof body === 'object' && 'data' in (body as any) ? (body as any).data : body;
  if (data == null) return true;
  if (Array.isArray(data)) return data.length === 0;
  return typeof data === 'object' && Object.keys(data).length === 0;
}

/** Plage de dates d'une requête d'analyse. ISO 8601, comme partout dans l'API. */
export interface DateRange {
  from: string;
  to: string;
}

/**
 * Lecture des chiffres, côté serveur, par l'API REST.
 *
 * Les mêmes nombres que la console. Ce sont des lectures d'API : à mettre en
 * cache, jamais sur le chemin d'un affichage de page.
 */
export class StreamlikeAnalytics {
  private readonly baseUrl: string;

  constructor(private readonly config: { apiToken: string; baseUrl?: string }) {
    if (!config?.apiToken) throw new Error('StreamlikeAnalytics: apiToken requis');
    this.baseUrl = (config.baseUrl || 'https://api.streamlike.com').replace(/\/$/, '');
  }

  private headers(): Record<string, string> {
    return { 'X-Streamlike-Authorization': `streamlikeAuth token="${this.config.apiToken}"` };
  }

  private get(path: string, query: Record<string, unknown> = {}, label = 'analytics'): Promise<any> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value == null || value === '') continue;
      if (Array.isArray(value)) for (const v of value) params.append(`${key}[]`, String(v));
      else params.set(key, String(value));
    }
    const qs = params.toString();
    return apiFetch(`${this.baseUrl}${path}${qs ? `?${qs}` : ''}`, {
      method: 'GET',
      headers: this.headers(),
    }, `streamlike/${label}`);
  }

  private static range(range: DateRange): string {
    return `${encodeURIComponent(range.from)}/${encodeURIComponent(range.to)}`;
  }

  /** Lectures sur la période, par type. */
  playback(range: DateRange, filters: {
    mediaId?: string;
    playlistIds?: string[];
    tagIds?: string[];
    userToken?: string;
    period?: string;
    aggregation?: string;
  } = {}): Promise<any> {
    return this.get(`/analytics/playback/${StreamlikeAnalytics.range(range)}`, {
      media_id: filters.mediaId,
      playlist_ids: filters.playlistIds,
      tag_ids: filters.tagIds,
      user_token: filters.userToken,
      period: filters.period,
      aggregation: filters.aggregation,
    }, 'analytics/playback');
  }

  /** Médias les plus vus. */
  topPopular(range: DateRange): Promise<any> {
    return this.get(`/analytics/playback/top/popular/${StreamlikeAnalytics.range(range)}`, {}, 'analytics/top');
  }

  /** Répartition géographique. */
  location(range: DateRange, level: 'countries' | 'cities' | 'continents'): Promise<any> {
    return this.get(`/analytics/playback/location/${level}/${StreamlikeAnalytics.range(range)}`, {}, 'analytics/location');
  }

  /** Répartition par matériel. */
  client(range: DateRange, level: 'devices' | 'browsers' | 'os'): Promise<any> {
    return this.get(`/analytics/playback/client/${level}/${StreamlikeAnalytics.range(range)}`, {}, 'analytics/client');
  }

  /** Provenance des lectures. */
  referers(range: DateRange): Promise<any> {
    return this.get(`/analytics/playback/referers/${StreamlikeAnalytics.range(range)}`, {}, 'analytics/referers');
  }

  /** Courbe d'engagement d'un média — où les gens décrochent. */
  engagement(mediaId: string, range: DateRange, axis: 'connections' | 'qualities' = 'connections'): Promise<any> {
    return this.get(
      `/analytics/engagement/${encodeURIComponent(mediaId)}/${axis}/${StreamlikeAnalytics.range(range)}`,
      {}, 'analytics/engagement',
    );
  }

  /** Tableau média par média. */
  medias(range: DateRange, filters: { playlistIds?: string[]; encoded?: boolean; search?: string; range?: string } = {}): Promise<any> {
    return this.get(`/analytics/medias/${StreamlikeAnalytics.range(range)}`, {
      playlist_ids: filters.playlistIds,
      encoded: filters.encoded,
      search: filters.search,
      range: filters.range,
    }, 'analytics/medias');
  }

  /**
   * Un spectateur sur un média.
   *
   * N'a de sens que si le même `user_token` a été passé au player ET à
   * `eng.k`. Sinon la plateforme ne connaît personne de ce nom et répond des
   * zéros, ce qui se lit comme « il n'a rien regardé ».
   */
  userStats(mediaId: string, userToken: string, range: DateRange): Promise<any> {
    return this.get(
      `/analytics/userstats/${encodeURIComponent(mediaId)}/${encodeURIComponent(userToken)}/${StreamlikeAnalytics.range(range)}`,
      {}, 'analytics/userstats',
    );
  }

  /** Statistiques des jetons de lecture. */
  tokenStats(range: DateRange): Promise<any> {
    return this.get(`/analytics/tokenstats/${StreamlikeAnalytics.range(range)}`, {}, 'analytics/tokenstats');
  }

  /**
   * Ce que la facture compte : `GET /analytics/company/billable`.
   *
   * Deux lectures qui trompent :
   *  - `data.catalog.{date}.duration_total` est en **heures pondérées** depuis
   *    l'API 5.30 (la même unité que `catalog_limit`), plus en secondes. Les
   *    onze durées brutes à côté restent en secondes : `duration_total` n'est
   *    délibérément ni leur somme, ni dans leur unité. Un graphe bâti avant
   *    5.30 chute de trois ordres de grandeur sans lever d'erreur ;
   *  - `data.transfer` est un cumul : additionner les semaines compte plusieurs
   *    fois les mêmes octets.
   */
  billable(): Promise<any> {
    // Pas de période : toujours du début du contrat à maintenant, par semaines.
    return this.get('/analytics/company/billable', {}, 'analytics/billable');
  }

  /** Consommation : transfert, stockage, encodage, équivalent CO₂. */
  consumption(range: DateRange, kind: 'transfer' | 'storage' | 'encoding' | 'greenhousegas'): Promise<any> {
    return this.get(`/analytics/${kind}/${StreamlikeAnalytics.range(range)}`, {}, `analytics/${kind}`);
  }

  /** Audience. */
  viewership(range: DateRange): Promise<any> {
    return this.get(`/analytics/viewership/${StreamlikeAnalytics.range(range)}`, {}, 'analytics/viewership');
  }
}
