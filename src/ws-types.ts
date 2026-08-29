/**
 * Modèles des webservices `/ws/*`.
 *
 * Le JSON brut de Streamlike est profondément imbriqué et hétérogène : un média
 * arrive sous `{media: {metadata: {global: {...}}}}`, les listes sous
 * `[{media: {...}}]`, et **les blocs vides sont absents plutôt que vides** (un
 * média sans sous-titres n'a pas de clé `subtitles` du tout, mais un média sans
 * description porte bien `description: ""`). Écrit tel quel dans une vue, ça
 * donne des `?.` partout et un `undefined` qui remonte jusqu'à l'écran.
 *
 * On normalise donc une fois, ici. `raw` reste attaché pour les champs qu'on
 * n'aurait pas prévus — la plateforme en ajoute plus vite que cette lib.
 */

/** Un média tel que `/ws/media` et `/ws/playlist` le décrivent, aplati. */
export interface WsMedia {
  id: string;
  name: string;
  permalink: string;
  /** `video`, `audio`, … tel que la plateforme le renvoie. */
  type: string;
  status: string;
  description: string;
  /** Transcription complète, quand la reconnaissance vocale a tourné. */
  transcript: string;
  credits: string;
  /** Durée en SECONDES (la plateforme ne renvoie jamais de millisecondes ici). */
  durationSec: number;
  /**
   * Rapport largeur/hauteur, à donner tel quel à une enveloppe responsive :
   * `padding-top: 100 / ratio %`. Vaut 0 si la plateforme ne l'a pas calculé —
   * ne pas diviser sans vérifier.
   */
  ratio: number;
  fps: number;
  createdAt: string;
  releasedAt: string;
  updatedAt: string;
  lastPlaybackAt: string;
  is360: boolean;
  isMultipleAudio: boolean;
  isTokenized: boolean;
  hasPassword: boolean;
  isDownloadable: boolean;
  isSecured: boolean;
  /** URL de partage publique fournie par la plateforme. */
  universalUrl: string;
  cover: WsCover;
  /** Storyboard (mosaïque de vignettes) — chaîne vide si absent. */
  mosaicUrl: string;
  board: { smallUrl: string; largeUrl: string };
  subtitles: WsSubtitle[];
  /** Codes de langue présents sur le média (`fr`, `en`, …). */
  languages: string[];
  playlists: WsMediaPlaylist[];
  keywords: string[];
  statistics: WsStatistics;
  /**
   * URL du manifeste de fichiers (index JSON de tous les encodages).
   * C'est la voie SANS liste blanche d'IP vers le master HLS —
   * `/ws/manifest` donne la même chose mais exige une IP autorisée.
   */
  manifestUrl: string | null;
  /** La réponse non normalisée, pour tout ce qui n'est pas modélisé ici. */
  raw: any;
}

export interface WsCover {
  url: string;
  thumbnailUrl: string;
  thumbnailLargeUrl: string;
  thumbnailExtraLargeUrl: string;
}

export interface WsSubtitle {
  language: string;
  dfxp: string;
  vtt: string;
  srt: string;
  m3u8: string;
}

export interface WsMediaPlaylist {
  id: string;
  name: string;
  type: string;
  position: number;
}

export interface WsStatistics {
  /** Compteur de lectures (`statistics.media_access`). */
  playbacks: number;
  ratingHits: number;
  ratingTotal: number;
  /** `ratingTotal / ratingHits`, ou `null` quand personne n'a voté. */
  ratingAverage: number | null;
}

/** Une page de `/ws/playlist`. */
export interface WsPlaylistPage {
  playlistId: string;
  name: string;
  language: string;
  /**
   * Taille de la playlist ENTIÈRE, pas de la page — c'est elle qui pilote la
   * pagination et l'état « fin de liste ».
   */
  size: number;
  totalDurationSec: number;
  medias: WsMedia[];
  /** Décalage demandé, recopié pour enchaîner sans le retenir soi-même. */
  offset: number;
  limit: number;
  /** Décalage de la page suivante, ou `null` s'il n'y en a pas. */
  nextOffset: number | null;
  raw: any;
}

/** Une playlist telle que `/ws/playlists` la liste. */
export interface WsPlaylistSummary {
  id: string;
  name: string;
  description: string;
  language: string;
  totalDurationSec: number;
  viewPosition: number;
  mediaCount: number;
  raw: any;
}

/** État de lecture d'un média pour un `user_token` donné. */
export interface WsResume {
  mediaId: string;
  /** Dernière position vue, en secondes. 0 si le spectateur est inconnu. */
  positionSec: number;
  raw: any;
}

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Booléen de la plateforme.
 *
 * Les drapeaux arrivent tantôt en `true`, tantôt en `"1"`, tantôt en `1`, et
 * `"0"` est une chaîne non vide — donc vrai pour JavaScript. Un `!!` naïf sur
 * `is_tokenized: "0"` masquerait tout le catalogue.
 */
function bool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = str(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

/**
 * Déballe les listes `[{media: {...}}]` que Streamlike renvoie.
 *
 * Chaque entrée est un objet à une seule clé qui répète le nom du type. On
 * accepte aussi la forme nue au cas où une version de la plateforme cesserait
 * d'envelopper.
 */
function unwrapList(raw: unknown, key: string): any[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(entry => (entry && typeof entry === 'object' && key in entry ? (entry as any)[key] : entry))
    .filter(entry => entry != null);
}

/** Normalise un média, quelle que soit sa provenance (`media` ou `playlist`). */
export function normalizeWsMedia(raw: any): WsMedia {
  const media = raw?.media ?? raw ?? {};
  const meta = media.metadata ?? {};
  const g = meta.global ?? {};
  const custom = meta.customization ?? {};
  const cover = custom.cover ?? {};
  const board = custom.board ?? {};
  const stats = media.statistics ?? {};

  const ratingHits = num(stats.rating_hits);
  const ratingTotal = num(stats.rating_totalvalue);

  // Le manifeste vit dans `html5_sources`, une liste dont on ne veut qu'une
  // entrée : celle qui porte une URL de manifeste. Les autres décrivent des
  // sources historiques dont plus rien ne se sert.
  const sources = unwrapList(media.html5_sources, 'html5_source');
  const manifestUrl = sources.map(s => str(s?.manifest)).find(u => u !== '') ?? null;

  return {
    id: str(g.media_id),
    name: str(g.name),
    permalink: str(g.permalink),
    type: str(g.type) || 'video',
    status: str(g.status),
    description: str(g.description),
    transcript: str(g.transcript),
    credits: str(g.credits),
    durationSec: num(g.duration),
    ratio: num(g.ratio),
    fps: num(g.fps),
    createdAt: str(g.creation_date),
    releasedAt: str(g.release_date),
    updatedAt: str(g.lastupdated_date),
    lastPlaybackAt: str(g.lastplayback_date),
    is360: bool(g.is_360),
    isMultipleAudio: bool(g.is_multiple_audio),
    isTokenized: bool(g.is_tokenized),
    hasPassword: bool(g.has_password),
    isDownloadable: bool(g.is_downloadable),
    isSecured: bool(g.is_secured),
    universalUrl: str(meta.share?.universal_url),
    cover: {
      url: str(cover.url),
      thumbnailUrl: str(cover.thumbnail_url),
      thumbnailLargeUrl: str(cover.thumbnaillarge_url),
      thumbnailExtraLargeUrl: str(cover.thumbnailextralarge_url),
    },
    mosaicUrl: str(custom.mosaic),
    board: { smallUrl: str(board.small_url), largeUrl: str(board.large_url) },
    subtitles: unwrapList(meta.subtitles, 'subtitle').map(s => ({
      language: str(s.language_id),
      dfxp: str(s.url?.dfxp),
      vtt: str(s.url?.vtt),
      srt: str(s.url?.srt),
      m3u8: str(s.url?.m3u8),
    })),
    languages: unwrapList(meta.language_ids, 'language_id')
      .map(l => (typeof l === 'string' ? l : str(l?.language_id)))
      .filter(Boolean),
    playlists: unwrapList(meta.playlists, 'playlist').map((p, index) => ({
      id: str(p.playlist_id),
      name: str(p.name),
      type: str(p.type),
      position: num(p.position) || index + 1,
    })),
    keywords: unwrapList(meta.keywords?.standard_keywords, 'standard_keyword')
      .map(k => (typeof k === 'string' ? k : str(k)))
      .filter(Boolean),
    statistics: {
      playbacks: num(stats.media_access),
      ratingHits,
      ratingTotal,
      ratingAverage: ratingHits > 0 ? ratingTotal / ratingHits : null,
    },
    manifestUrl,
    raw: media,
  };
}

/** Normalise une réponse `/ws/playlist`. */
export function normalizeWsPlaylistPage(
  raw: any,
  paging: { offset: number; limit: number },
): WsPlaylistPage {
  const playlist = raw?.playlist ?? raw ?? {};
  const meta = playlist.metadata ?? {};
  const medias = unwrapList(playlist.medias, 'media').map(m => normalizeWsMedia({ media: m }));
  const size = num(meta.size);
  const next = paging.offset + paging.limit;
  return {
    playlistId: str(meta.playlist_id),
    name: str(meta.name),
    language: str(meta.language),
    size,
    totalDurationSec: num(meta.total_duration),
    medias,
    offset: paging.offset,
    limit: paging.limit,
    // On s'appuie sur `size` — la taille de la playlist entière — plutôt que
    // sur « la page est pleine » : une page pleine ET finale ferait sinon
    // demander une page vide de plus à chaque parcours.
    nextOffset: medias.length > 0 && next < size ? next : null,
    raw: playlist,
  };
}

/** Normalise une entrée de `/ws/playlists`. */
export function normalizeWsPlaylistSummary(raw: any): WsPlaylistSummary {
  const p = raw?.playlist ?? raw ?? {};
  return {
    id: str(p.playlist_id ?? p.id),
    name: str(p.name),
    description: str(p.description),
    language: str(p.language),
    totalDurationSec: num(p.total_duration),
    viewPosition: num(p.view_position),
    mediaCount: num(p.size ?? p.media_count),
    raw: p,
  };
}

export { unwrapList as unwrapWsList, bool as wsBool, num as wsNum, str as wsStr };
