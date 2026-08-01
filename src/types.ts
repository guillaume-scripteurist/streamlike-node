export interface MediatechConfig {
  /** Jeton utilisateur Mediatech (API_TOKEN). */
  apiToken: string;
  /** `encrypted_account_id` du compte Mediatech. */
  accountId: string;
  /** Base d'API (défaut https://api.mediatech.fr). */
  baseUrl?: string;
}

export interface StreamlikeConfig {
  /** Jeton API Streamlike. */
  apiToken: string;
  /** Base d'API (défaut https://api.streamlike.com). */
  baseUrl?: string;
}

/** Champ personnalisé d'une playlist ou d'un média. */
export interface CustomField {
  name: string;
  value: string;
  public?: boolean;
}

/** Playlist telle qu'elle apparaît dans une vue (ou vue vue depuis une playlist). */
export interface OrgRef {
  id: string;
  name: string;
  position: number;
}

/**
 * Playlist de l'organisation, telle que la renvoie `GET /organization/playlists`.
 *
 * Le listing porte déjà `description`, `custom_fields` et `views` : une seule
 * requête suffit donc à reconstruire un classement complet, sans appel de
 * détail playlist par playlist.
 */
export interface PlaylistRow {
  id: string;
  name: string;
  description: string;
  customs: CustomField[];
  views: OrgRef[];
  mediaCount: number;
}

export interface ViewRow {
  id: string;
  name: string;
  playlists: OrgRef[];
}

export interface PlaylistInput {
  name: string;
  description?: string;
  customs?: CustomField[];
}

export interface SignUploadInput {
  filename: string;
  contentType?: string;
  maxBytes?: number;
  callbackUrl: string;
}

export interface SignUploadResponse {
  upload_url: string;
  blob_path: string;
  required_headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface CompleteUploadResponse {
  task_id: string;
  [key: string]: unknown;
}

export interface CreateMediaInput {
  name: string;
  permalink: string;
  sourceUrl?: string;
  type?: string;
  tagIds?: Array<string | number>;
  /** Playlist unique (compat historique). Fusionnée avec `playlistIds`. */
  playlistId?: string | number;
  /** Playlists multiples : session, joueur, question… */
  playlistIds?: Array<string | number>;
  description?: string;
  /** Code langue (ex. `fr`) : déclenche la transcription automatique à l'encodage. */
  speechToText?: string;
  /** Champ personnalisé PSEUDO Streamlike */
  pseudo?: string;
  /** Champ personnalisé ALIAS Streamlike */
  alias?: string;
}

export interface UploadMediaInput {
  /** Contenu du fichier. `Blob` (voir `fs.openAsBlob`) ou `Buffer`/`Uint8Array`. */
  file: Blob | Uint8Array;
  /** Nom de fichier transmis dans le multipart (l'extension compte). */
  filename: string;
  name: string;
  permalink: string;
  type?: string;
  description?: string;
  tagIds?: Array<string | number>;
  playlistIds?: Array<string | number>;
  /** Type MIME, si `file` n'est pas déjà un Blob typé. */
  contentType?: string;
  /** Champ personnalisé PSEUDO Streamlike */
  pseudo?: string;
  /** Champ personnalisé ALIAS Streamlike */
  alias?: string;
}

/** Filtres de `GET /medias`. Tous optionnels : sans rien, on liste tout. */
export interface ListMediasInput {
  /** Recherche plein texte (nom, description…). */
  search?: string;
  /** Index du premier élément (pagination `range=first-last`). */
  offset?: number;
  /** Nombre d'éléments demandés. L'API plafonne à sa propre limite. */
  limit?: number;
  /** Tri, forme `champ|asc` ou `champ|desc` (par défaut `created_at|desc`). */
  sort?: string;
  playlistIds?: Array<string | number>;
  tagIds?: Array<string | number>;
  /** `video` | `audio` | `live`. */
  type?: string;
  /** `online` | `offline` | `archived`. */
  visibility?: string;
  /** Ne garder que les médias encodés (donc réellement diffusables). */
  encoded?: boolean;
}

export interface ListMediasResult {
  items: any[];
  /** Total côté serveur — sert à savoir s'il reste des pages. */
  total: number;
  offset: number;
  limit: number;
}

export type EncodingStatus =
  | 'none' | 'pending' | 'running' | 'done' | 'error'
  | 'unknown' | 'polling_error' | 'timeout';

export interface EncodingStatusResult {
  status: EncodingStatus;
  isEncoded: boolean;
  raw: Record<string, unknown>;
}

export interface PollEncodingOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

export interface PollHandle {
  cancel(): void;
}
