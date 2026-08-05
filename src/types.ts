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
  /**
   * Réglages d'encodage appliqués par défaut à tous les envois de ce client.
   * Surchargeables appel par appel via `EncodeOptions` sur l'entrée.
   */
  encode?: EncodeOptions;
}

/**
 * Réglages d'encodage transmis à Streamlike au dépôt d'un média.
 *
 * Ils étaient codés en dur dans `uploadMedia` (transcription française
 * systématique, passthru toujours actif) : une borne posée chez un client
 * anglophone produisait des sous-titres en français sans qu'aucun réglage ne
 * permette de le corriger. Les défauts ci-dessous reprennent exactement
 * l'ancien comportement — renseigner ces options ne change rien tant qu'on ne
 * les renseigne pas.
 */
export interface EncodeOptions {
  /**
   * Génération automatique des sous-titres (`speech_to_text`).
   * Défaut `true`.
   */
  speechToText?: boolean;
  /**
   * Langue parlée dans la vidéo, code ISO (`fr`, `en`, `es`, `de`…).
   * Défaut `fr`. Ignoré si `speechToText` vaut `false`.
   */
  speechToTextLanguage?: string;
  /**
   * Traduction automatique des sous-titres générés. Défaut `true`.
   * Ignoré si `speechToText` vaut `false`.
   */
  automaticTranslation?: boolean;
  /**
   * Bypasser le ré-encodage quand la source est déjà lisible telle quelle
   * (`encoding_passthru`) : la vidéo est disponible bien plus vite, au prix du
   * respect strict des profils du compte. Défaut `true`.
   */
  encodingPassthru?: boolean;
}

/**
 * Réglages effectifs, une fois les défauts appliqués.
 * @internal
 */
export interface ResolvedEncodeOptions {
  speechToText: boolean;
  speechToTextLanguage: string;
  automaticTranslation: boolean;
  encodingPassthru: boolean;
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
  /**
   * Raccourci historique : code langue (ex. `fr`) activant la transcription.
   * Équivaut à `encode: { speechToText: true, speechToTextLanguage: '<code>' }`.
   * Une valeur vide/absente laisse `encode` (ou le défaut du client) décider.
   */
  speechToText?: string;
  /** Réglages d'encodage pour cet appel. Priment sur ceux du client. */
  encode?: EncodeOptions;
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
  /** Réglages d'encodage pour cet appel. Priment sur ceux du client. */
  encode?: EncodeOptions;
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
