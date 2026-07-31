import { apiFetch } from './http';
import type {
  StreamlikeConfig,
  CreateMediaInput,
  UploadMediaInput,
  EncodingStatusResult,
  ListMediasInput,
  ListMediasResult,
  PollEncodingOptions,
  PollHandle,
} from './types';

/**
 * Client Streamlike : crée un média encodé depuis une URL source, gère les
 * tags/playbacks, et POLLE le statut d'encodage (Streamlike n'a pas de webhook).
 * À utiliser côté serveur uniquement (détient le jeton API).
 */
export class StreamlikeClient {
  private readonly baseUrl: string;

  constructor(private readonly config: StreamlikeConfig) {
    if (!config?.apiToken) throw new Error('StreamlikeClient: apiToken requis');
    this.baseUrl = (config.baseUrl || 'https://api.streamlike.com').replace(/\/$/, '');
  }

  private authHeaders(): Record<string, string> {
    return { 'X-Streamlike-Authorization': `streamlikeAuth token="${this.config.apiToken}"` };
  }

  /**
   * Crée un média en encodant depuis `sourceUrl` (sans binaire à joindre).
   *
   * L'OpenAPI publié documente ces paramètres en QUERY, mais un appel réel a
   * montré l'API refuser cette forme (`INVALID_FORM`/`UNKNOWN_FIELDS`) — sur ce
   * point la doc ment. La forme qui fonctionne est un corps JSON :
   * `{name, permalink, type, visibility:{state}, source, description, tag_ids,
   * playlists}`. `source` = l'URL MP4 (encode-from-URL, à la place du binaire
   * `source[media_file]` du multipart de {@link uploadMedia}).
   */
  createMedia(input: CreateMediaInput): Promise<any> {
    const payload: Record<string, unknown> = {
      name: input.name,
      permalink: input.permalink,
      type: input.type || 'video',
      visibility: { state: 'online' },
    };
    if (input.sourceUrl) payload.source = input.sourceUrl;
    if (input.description) payload.description = input.description;

    if (input.pseudo || input.alias) {
      payload.customs = [
        ...(input.pseudo ? [{ name: 'PSEUDO', value: input.pseudo, public: true }] : []),
        ...(input.alias ? [{ name: 'ALIAS', value: input.alias, public: true }] : []),
      ];
    }
    const tagIds = (input.tagIds || []).filter(t => t != null);
    if (tagIds.length) payload.tag_ids = tagIds;
    // Un média peut appartenir à plusieurs playlists (session, joueur,
    // question). On déduplique : la même playlist envoyée deux fois est au
    // mieux inutile, au pire refusée.
    const playlists = [...new Set(
      [...(input.playlistIds || []), input.playlistId]
        .filter((p): p is string | number => p != null && p !== '')
        .map(String),
    )];
    if (playlists.length) payload.playlists = playlists;

    // Transcription à l'encodage : `source` reste la CHAÎNE validée ci-dessus
    // (impossible d'y imbriquer `encode.speech_to_text` sans la transformer en
    // objet, ce qui casserait la forme éprouvée) — on reprend donc les mêmes
    // clés en notation à crochets que {@link uploadMedia} (confirmées sur un
    // appel réel côté multipart), mais comme clés JSON à plat. Non encore
    // vérifié côté JSON : à confirmer sur un appel réel.
    if (input.speechToText) {
      payload['source[encode][speech_to_text][type]'] = 'subtitle';
      payload['source[encode][speech_to_text][automatic_translation]'] = 'true';
      payload['source[encode][speech_to_text][language]'] = input.speechToText;
    }

    return apiFetch(`${this.baseUrl}/medias`, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, 'streamlike/createMedia');
  }

  /**
   * Crée un média en ENVOYANT le fichier (multipart), sans passer par une URL
   * source. C'est la voie utilisable quand on détient le binaire localement et
   * qu'on n'a pas d'URL publique à donner à Streamlike — typiquement un kiosque
   * posé dans une salle.
   *
   * Format validé sur un appel réel (201). Trois pièges, tous silencieux :
   *  1. TOUT passe dans le payload. Les paramètres mis en query sont IGNORÉS
   *     dès qu'il y a un corps multipart, et l'API répond `MANDATORY_*`.
   *  2. Le champ fichier est `source[encode][media_file]`. `source[media_file]`,
   *     montré dans la doc officielle, est rejeté en `UNKNOWN_FIELDS`.
   *  3. `resource` doit être appendé comme CHAÎNE. En Blob, le multipart porte
   *     un `filename`, l'API le prend pour un fichier -> `UNKNOWN_FIELDS`.
   */
  uploadMedia(input: UploadMediaInput): Promise<any> {
    const resource: Record<string, unknown> = {
      name: input.name,
      permalink: input.permalink,
      type: input.type || 'video',
      visibility: { state: 'online' },
    };
    if (input.description) resource.description = input.description;
    if (input.pseudo || input.alias) {
      resource.customs = [
        ...(input.pseudo ? [{ name: 'PSEUDO', value: input.pseudo, public: true }] : []),
        ...(input.alias ? [{ name: 'ALIAS', value: input.alias, public: true }] : []),
      ];
    }
    const tags = (input.tagIds || []).filter(t => t != null && t !== '').map(String);
    if (tags.length) resource.tag_ids = tags;
    const playlists = [...new Set((input.playlistIds || []).filter(p => p != null && p !== '').map(String))];
    if (playlists.length) resource.playlists = playlists.map((id, index) => ({ id, position: index + 1 }));

    const body = new FormData();
    body.append('resource', JSON.stringify(resource)); // chaîne, surtout pas un Blob
    const blob = input.file instanceof Blob
      ? input.file
      // Le cast contourne le typage strict de BlobPart en TS 5.9 : un
      // `Uint8Array<ArrayBufferLike>` pourrait théoriquement porter un
      // SharedArrayBuffer, ce qui n'arrive pas ici (Buffer de fs.readFile).
      : new Blob([input.file as unknown as BlobPart], { type: input.contentType || 'video/mp4' });
    body.append('source[encode][media_file]', blob, input.filename);
    // Passthru : la source est déjà dans un format lisible tel quel, inutile
    // de la ré-encoder — accélère la disponibilité de la vidéo après upload.
    body.append('source[encode][encoding_passthru]', '1');
    body.append('source[encode][speech_to_text][type]', 'subtitle');
    body.append('source[encode][speech_to_text][automatic_translation]', 'true');
    body.append('source[encode][speech_to_text][language]', 'fr');

    // Pas de Content-Type explicite : fetch doit poser lui-même la frontière
    // (`boundary=…`) du multipart.
    return apiFetch(`${this.baseUrl}/medias`, {
      method: 'POST',
      headers: this.authHeaders(),
      body,
    }, 'streamlike/uploadMedia');
  }

  /**
   * Liste les médias du compte (`GET /medias`).
   *
   * La pagination de Streamlike s'exprime en `range=premier-dernier` et non en
   * page/taille : on traduit ici depuis `offset`/`limit`, plus naturels côté
   * appelant. La réponse expose `total_count`, ce qui permet à une console de
   * savoir s'il reste des pages sans avoir à en demander une de trop.
   */
  async listMedias(input: ListMediasInput = {}): Promise<ListMediasResult> {
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const limit = Math.max(1, Math.floor(input.limit ?? 50));
    const params = new URLSearchParams();
    params.set('range', `${offset}-${offset + limit - 1}`);
    params.set('sorts', input.sort || 'created_at|desc');
    if (input.search) params.set('search', input.search);
    if (input.type) params.set('type', input.type);
    if (input.visibility) params.set('visibility.state', input.visibility);
    if (input.encoded != null) params.set('encoded', input.encoded ? 'true' : 'false');
    for (const p of input.playlistIds || []) if (p != null && p !== '') params.append('playlist_ids[]', String(p));
    for (const t of input.tagIds || []) if (t != null && t !== '') params.append('tag_ids[]', String(t));

    const body = await apiFetch(`${this.baseUrl}/medias?${params.toString()}`, {
      method: 'GET',
      headers: this.authHeaders(),
    }, 'streamlike/listMedias');

    // L'API répond `{ data, total_count }` en 200/206 ; on tolère un tableau nu
    // au cas où une version renverrait directement la collection.
    const items = Array.isArray(body?.data) ? body.data : (Array.isArray(body) ? body : []);
    const total = Number(body?.total_count ?? items.length) || items.length;
    return { items, total, offset, limit };
  }

  /**
   * Liste les playlists de l'organisation (`GET /organization/playlists`).
   * Même service que {@link searchPlaylists}, mais sans filtre de nom et avec
   * la pagination : sert à peupler un sélecteur de playlists.
   */
  async listPlaylists(input: { search?: string; offset?: number; limit?: number } = {}): Promise<Array<{ id: string; name: string }>> {
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const limit = Math.max(1, Math.floor(input.limit ?? 100));
    const params = new URLSearchParams({
      range: `${offset}-${offset + limit - 1}`,
    });
    if (input.search) params.set('search', input.search);
    const body = await apiFetch(
      `${this.baseUrl}/organization/playlists?${params.toString()}`,
      { method: 'GET', headers: this.authHeaders() },
      'streamlike/listPlaylists',
    );
    const rows = Array.isArray(body?.data) ? body.data : (Array.isArray(body) ? body : []);
    return rows.filter((r: any) => r && r.id).map((r: any) => ({
      id: String(r.id),
      name: r.name || ''
    }));
  }

  /**
   * Liste les vues de l'organisation (`GET /organization/views`).
   * Une vue est un regroupement de playlists distinct de la playlist
   * elle-même — {@link addPlaylistToView} sert à y rattacher une playlist.
   */
  async listViews(): Promise<Array<{ id: string; name: string; playlists: string[] }>> {
    const body = await apiFetch(
      `${this.baseUrl}/organization/views?range=0-99`,
      { method: 'GET', headers: this.authHeaders() },
      'streamlike/listViews',
    );
    const rows = Array.isArray(body?.data) ? body.data : (Array.isArray(body) ? body : []);
    return rows.filter((r: any) => r && r.id).map((r: any) => ({
      id: String(r.id),
      name: r.name || '',
      playlists: (Array.isArray(r.playlists) ? r.playlists : []).map((p: any) => String(p.id))
    }));
  }

  async getView(viewId: string): Promise<{ id: string; name: string; playlists: string[] }> {
    const r = await apiFetch(
      `${this.baseUrl}/organization/views/${encodeURIComponent(viewId)}`,
      { method: 'GET', headers: this.authHeaders() },
      'streamlike/getView',
    );
    if (!r || !r.id) throw new Error(`Vue non trouvée : ${viewId}`);
    return {
      id: String(r.id),
      name: r.name || '',
      playlists: (Array.isArray(r.playlists) ? r.playlists : []).map((p: any) => String(p.id))
    };
  }

  /**
   * Rattache une playlist à une vue.
   *
   * Il n'existe pas d'endpoint additif : une vue POSSÈDE sa liste de
   * playlists (`playlists: string[]`), et `PATCH /organization/views/{id}`
   * REMPLACE tout le tableau. On fait donc une lecture-modification-écriture :
   * lire la vue, ajouter l'id s'il n'y est pas déjà, réécrire le tableau
   * complet. Idempotent (no-op si la playlist y figure déjà) — l'appelant
   * est responsable de sérialiser les appels concurrents sur une même vue
   * (deux lecture-modification-écriture en parallèle pourraient s'écraser).
   */
  async addPlaylistToView(viewId: string, playlistId: string): Promise<void> {
    const view = await this.getView(viewId).catch(() => ({ playlists: [] as string[] }));
    const current = view.playlists;
    if (current.includes(String(playlistId))) return;
    await apiFetch(
      `${this.baseUrl}/organization/views/${encodeURIComponent(viewId)}`,
      {
        method: 'PATCH',
        headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ playlists: [...current, String(playlistId)].map(id => ({ id })) }),
      },
      'streamlike/patchView',
    );
  }

  /**
   * Édite les champs personnalisés d'un média (PSEUDO et ALIAS).
   */
  async updateMediaCustoms(mediaId: string, pseudo: string, alias: string): Promise<any> {
    const customs = [];
    if (pseudo != null) customs.push({ name: 'PSEUDO', value: pseudo,public:true });
    if (alias != null) customs.push({ name: 'ALIAS', value: alias,public:true });
    
    return apiFetch(
      `${this.baseUrl}/medias/${encodeURIComponent(mediaId)}`,
      {
        method: 'PATCH',
        headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ customs,customs_merge:true }),
      },
      'streamlike/updateMediaCustoms',
    );
  }

  /** Lit et normalise le statut d'encodage d'un média. */
  async getEncodingStatus(mediaId: string): Promise<EncodingStatusResult> {
    const media = await apiFetch(`${this.baseUrl}/medias/${encodeURIComponent(mediaId)}`, {
      method: 'GET',
      headers: this.authHeaders(),
    }, 'streamlike/getMedia');
    const status = (media?.source?.encoding_status)
      || media?.['source.encoding_status']
      || 'unknown';
    const isEncoded = Boolean(
      media?.source?.is_encoded ?? media?.['source.is_encoded'] ?? (status === 'done'),
    );
    return { status, isEncoded, raw: media };
  }

  /** Crée un tag (idempotent côté usage) et renvoie son identifiant. */
  async ensureTag(name: string): Promise<string | number | null> {
    const created = await apiFetch(
      `${this.baseUrl}/organization/tags`,
      {
        method: 'POST',
        headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      },
      'streamlike/createTag',
    );
    return created?.id ?? created?.tag_id ?? created?.permalink ?? null;
  }

  /**
   * Crée une playlist et renvoie son identifiant.
   *
   * Même forme que {@link ensureTag} : les métadonnées passent en corps JSON
   * (et non en query, malgré l'OpenAPI publié — voir {@link createMedia}), la
   * réponse expose l'id sous l'une des clés usuelles de l'API. Le chemin est
   * surchargeable (`config.playlistPath`) car il n'est pas documenté dans
   * l'OpenAPI publié.
   */
  async createPlaylist(name: string, description: string = ''): Promise<string | number | null> {
    const p = (this.config.playlistPath || '/organization/playlists').replace(/^\/?/, '/');
    const payload: Record<string, unknown> = { name };
    if (description) payload.description = description;
    const created = await apiFetch(
      `${this.baseUrl}${p}`,
      {
        method: 'POST',
        headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      'streamlike/createPlaylist',
    );
    return created?.id ?? created?.playlist_id ?? created?.permalink ?? null;
  }

  /**
   * Cherche des playlists par nom (`GET /organization/playlists?search=`).
   *
   * Sert à retrouver une playlist déjà créée plutôt qu'à en empiler une
   * nouvelle : le cache du serveur de jeu vit en mémoire, donc un redémarrage
   * en pleine soirée recréerait sinon « Joueur — Marie » une seconde fois.
   */
  async searchPlaylists(name: string): Promise<Array<{ id: string; name: string }>> {
    const params = new URLSearchParams({ search: name });
    const body = await apiFetch(
      `${this.baseUrl}/organization/playlists?${params.toString()}`,
      { method: 'GET', headers: this.authHeaders() },
      'streamlike/searchPlaylists',
    );
    const rows = Array.isArray(body?.data) ? body.data : (Array.isArray(body) ? body : []);
    return rows.filter((r: any) => r && r.id);
  }

  /** Crée un token de lecture (player protégé). */
  createPlaybackToken(
    mediaId: string,
    opts: { expireAt: string; ip?: string; userAgent?: string },
  ): Promise<any> {
    const payload = {
      expire_at: opts.expireAt,
      ip: opts.ip || '0.0.0.0',
      user_agent: opts.userAgent || 'secure-upload-player',
    };
    return apiFetch(
      `${this.baseUrl}/medias/${encodeURIComponent(mediaId)}/token`,
      {
        method: 'POST',
        headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      'streamlike/token',
    );
  }

  /**
   * Interroge le statut d'encodage jusqu'à `done`/`error` (ou expiration).
   * `onUpdate` est appelé à chaque changement de statut.
   */
  pollEncoding(
    mediaId: string,
    onUpdate: (update: EncodingStatusResult) => void,
    opts: PollEncodingOptions = {},
  ): PollHandle {
    const intervalMs = opts.intervalMs ?? 5000;
    const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;
    const startedAt = Date.now();
    let lastStatus: string | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        const update = await this.getEncodingStatus(mediaId);
        if (update.status !== lastStatus) {
          lastStatus = update.status;
          try { onUpdate(update); } catch { /* le consommateur gère ses erreurs */ }
        }
        if (update.status === 'done' || update.status === 'error') { stopped = true; return; }
      } catch (err) {
        try { onUpdate({ status: 'polling_error', isEncoded: false, raw: { error: (err as Error).message } }); } catch { /* noop */ }
      }
      if (Date.now() - startedAt > timeoutMs) {
        stopped = true;
        try { onUpdate({ status: 'timeout', isEncoded: false, raw: {} }); } catch { /* noop */ }
        return;
      }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    };

    timer = setTimeout(tick, intervalMs);
    return { cancel() { stopped = true; if (timer) clearTimeout(timer); } };
  }
}
