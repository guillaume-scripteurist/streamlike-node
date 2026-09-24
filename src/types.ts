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

/**
 * Réponse de `POST /upload/sign`.
 *
 * Les champs sont ceux que l'appelant doit VRAIMENT relayer à son client, et
 * ils étaient tous noyés dans l'index de secours `[key: string]: unknown` —
 * ce qui obligeait à les caster un par un, donc à les deviner.
 */
export interface SignUploadResponse {
  /** URL à appeler en POST pour ouvrir la session résumable. */
  upload_url: string;
  /** Chemin du blob. C'est la SEULE clé que le rappel rapportera. */
  blob_path: string;
  bucket?: string;
  /**
   * En-têtes que le stockage EXIGE à l'ouverture de session — dont
   * `x-goog-content-length-range`. « Any deviation will cause GCS to reject
   * the request » : ils se relaient tels quels, sans en ajouter ni en retirer.
   */
  required_headers?: Record<string, string>;
  /** Horodatage ISO-8601 d'expiration de l'URL signée. */
  expires_at?: string;
  /**
   * Bornes de taille SIGNÉES dans l'URL, et imposées par Google.
   *
   * À relayer jusqu'au client : sans elles, une vidéo trop lourde n'est
   * refusée qu'APRÈS avoir été poussée en entier.
   */
  min_bytes?: number;
  max_bytes?: number;
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
  /** Champs personnalisés arbitraires (ex. session_id, question_id, etc.) */
  customs?: CustomField[];
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
  /** Champs personnalisés arbitraires (ex. session_id, question_id, etc.) */
  customs?: CustomField[];
}

export interface CreateViewInput {
  name: string;
  description?: string;
  type?: string;
  playlists?: Array<string | number>;
}

/**
 * État de publication d'un média.
 *
 * `offline` le rend indiffusable sans rien détruire — c'est l'état d'une vidéo
 * retirée par son auteur ou mise de côté par l'organisateur, et il se défait.
 */
export type MediaVisibility = 'online' | 'offline' | 'archived';

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
  visibility?: MediaVisibility;
  /** Ne garder que les médias encodés (donc réellement diffusables). */
  encoded?: boolean;
  /**
   * `1` ou `2` : ne garder que les médias publiés par cet encodeur
   * (`source.encoding_version`, API 5.30). Un média qui ne publie rien n'est
   * rendu par aucune des deux valeurs.
   */
  encodingVersion?: 1 | 2;
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
  /**
   * Une opération d'encodage est en cours — pipeline complet, piste audio ou
   * sous-titre (`source.encoding_operation_running`, API 5.30). C'est le
   * moment où un ré-encodage, un changement de source, une suppression ou une
   * archive répondent `INVALID_MEDIA_ENCODING` : attendre plutôt qu'insister.
   */
  operationRunning: boolean;
  /**
   * La source revient de l'archive froide (`source.has_operation`, API 5.31).
   * Compter 3 à 5 heures ; le média n'est ni cassé ni bloqué, il attend.
   */
  restoring: boolean;
  /**
   * Encodeur des fichiers servis aujourd'hui, `null` tant que rien n'est publié.
   * Voir `WsMedia.encodingVersion` pour la règle de lecture.
   */
  encodingVersion: 1 | 2 | null;
  raw: Record<string, unknown>;
}

export interface PollEncodingOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

export interface PollHandle {
  cancel(): void;
}
