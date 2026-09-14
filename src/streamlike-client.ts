import { apiFetch } from './http';
import type {
  StreamlikeConfig,
  CreateMediaInput,
  UploadMediaInput,
  CustomField,
  EncodeOptions,
  ResolvedEncodeOptions,
  EncodingStatusResult,
  ListMediasInput,
  ListMediasResult,
  MediaVisibility,
  OrgRef,
  PlaylistInput,
  PlaylistRow,
  PollEncodingOptions,
  PollHandle,
  ViewRow,
} from './types';

/**
 * Champs personnalisés d'une playlist ou d'un média.
 *
 * L'API les renvoie tantôt en tableau `[{name, value, public}]`, tantôt en
 * objet `{nom: valeur}` selon le point d'entrée ; les noms sont normalisés en
 * minuscules parce que Streamlike les traite ainsi et qu'un `Duree` créé à la
 * main dans le back-office doit être relu comme le `duree` que nous écrivons.
 */
function normalizeCustoms(raw: unknown): CustomField[] {
  const rows = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === 'object'
      ? Object.entries(raw as Record<string, unknown>).map(([name, value]) => ({ name, value }))
      : []);
  return rows
    .filter((c: any) => c && c.name)
    .map((c: any) => ({
      name: String(c.name).trim().toLowerCase(),
      value: c.value == null ? '' : String(c.value),
      public: !!c.public,
    }));
}

function normalizeRefs(raw: unknown): OrgRef[] {
  const rows = Array.isArray(raw) ? raw : [];
  return rows
    .filter((r: any) => r && r.id != null)
    .map((r: any, index: number) => ({
      id: String(r.id),
      name: r.name || '',
      position: Number(r.position) || index + 1,
    }))
    .sort((a, b) => a.position - b.position);
}

function normalizePlaylist(r: any): PlaylistRow {
  return {
    id: String(r.id),
    name: r.name || '',
    description: r.description || '',
    customs: normalizeCustoms(r.custom_fields ?? r.customs),
    views: normalizeRefs(r.views),
    mediaCount: Number(r.media_count) || 0,
  };
}

function normalizeView(r: any): ViewRow {
  return {
    id: String(r.id),
    name: r.name || '',
    playlists: normalizeRefs(r.playlists),
  };
}

/**
 * Contrat d'écriture de `/organization/*`, vérifié sur le compte réel — la
 * documentation publiée décrit ces paramètres « in: query », et le bac à sable
 * les affiche à plat (`custom_fields[0][name]`) : les deux induisent en erreur.
 * Ce qui marche vraiment :
 *
 *  - corps JSON, comme pour `/medias`. Les mêmes paramètres passés en query
 *    sont refusés (`INVALID_FORM`/`UNKNOWN_FIELDS`) ;
 *  - `custom_fields` : `[{name, value, public}]` ;
 *  - `playlists` d'une vue : `[{id, position}]` — un tableau d'identifiants nus
 *    vaut `INVALID_PLAYLIST`, et omettre `position`, `MANDATORY_PLAYLIST_POSITION`.
 *
 * Attention en revanche à la LECTURE : l'API met une à trois secondes à
 * refléter une écriture, et `fields` s'écrit `fields[]=a&fields[]=b` (la forme
 * `fields=a,b` vaut `INVALID_FIELDS`). Relire aussitôt après avoir écrit rend
 * donc l'ancien état — ne pas en conclure que l'écriture a été ignorée.
 */

/**
 * Défauts d'encodage : exactement le comportement d'avant leur introduction
 * (transcription française traduite, passthru actif). Un appel qui ne renseigne
 * rien produit donc la même requête qu'auparavant.
 */
const ENCODE_DEFAULTS: ResolvedEncodeOptions = {
  speechToText: true,
  speechToTextLanguage: 'fr',
  automaticTranslation: true,
  encodingPassthru: true,
};

/** Fusionne défauts du package < défauts du client < réglages de l'appel. */
function resolveEncode(...layers: Array<EncodeOptions | undefined>): ResolvedEncodeOptions {
  const out: ResolvedEncodeOptions = { ...ENCODE_DEFAULTS };
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.speechToText != null) out.speechToText = !!layer.speechToText;
    if (layer.speechToTextLanguage) out.speechToTextLanguage = String(layer.speechToTextLanguage).trim();
    if (layer.automaticTranslation != null) out.automaticTranslation = !!layer.automaticTranslation;
    if (layer.encodingPassthru != null) out.encodingPassthru = !!layer.encodingPassthru;
  }
  return out;
}

/** Champs personnalisés prêts à être envoyés (nom en minuscules, visibilité explicite). */
function customsPayload(customs: CustomField[], isPublic: boolean) {
  return customs.map(c => ({
    name: String(c.name).trim().toLowerCase(),
    value: c.value == null ? '' : String(c.value),
    public: c.public ?? isPublic,
  }));
}

/**
 * Client Streamlike : crée un média encodé depuis une URL source, gère les
 * tags/playbacks, et POLLE le statut d'encodage (Streamlike n'a pas de webhook).
 * À utiliser côté serveur uniquement (détient le jeton API).
 *
 * ## La clé à lui donner
 *
 * Une clé d'API agit comme le compte qui l'a créée — avec TOUS ses droits, sauf
 * si elle a été restreinte (API 5.30 : bloc « Droits de la clé » du back-office,
 * ou `roles[]` sur `POST /me/keys`). Donner à chaque intégration sa propre clé,
 * limitée aux rôles qu'elle exerce et datée d'expiration : une borne qui ne
 * fait que déposer n'a pas besoin de pouvoir supprimer le catalogue.
 *
 * ## Fenêtres de maintenance
 *
 * Les lectures (`getMedia`, `pollEncoding`, listes) passent pendant une
 * fenêtre annoncée ; les écritures (`createMedia`, `uploadMedia`, playlists,
 * jetons) répondent `401 API_OFFLINE` et n'écrivent rien. C'est
 * {@link ApiError.isOffline} — à garder en file et rejouer, pas à traiter
 * comme une clé morte. Une liste lue pendant la fenêtre peut être COURTE sans
 * le dire : ne jamais réconcilier un stock local dessus.
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
   * point la doc ment. La forme qui fonctionne est un corps JSON.
   *
   * ## Les deux erreurs que cette méthode a portées, et leur forme juste
   *
   * Le corps est du JSON **imbriqué**, pas des clés à crochets à plat. La
   * notation `source[encode][media_url]` de la documentation décrit un chemin
   * de champ de FORMULAIRE ; envoyée telle quelle comme clé JSON, elle revient
   * en `UNKNOWN_FIELDS`. `visibility: { state }`, qui a toujours fonctionné,
   * disait déjà que ce corps s'imbrique.
   *
   *  - l'URL source va dans `source.encode.media_url`. Elle partait à la
   *    racine, en `source: "<url>"` — et comme les clés de transcription
   *    partaient à côté sous `source[encode]…`, l'API voyait `source` déclaré
   *    deux fois, scalaire et structure : `INVALID_SOURCE` + `UNKNOWN_FIELDS`,
   *  - `playlists` est un tableau d'OBJETS `{ id, position }`, `position`
   *    entier à partir de 1. Il partait en tableau de chaînes :
   *    `INVALID_PLAYLIST`. Les identifiants sont ceux, chiffrés, que rend la
   *    plateforme — jamais un numéro d'ordre interne. Sans identifiant, la clé
   *    n'est pas émise du tout : un tableau vide est un refus, pas un silence.
   */
  createMedia(input: CreateMediaInput): Promise<any> {
    const payload: Record<string, unknown> = {
      name: input.name,
      permalink: input.permalink,
      type: input.type || 'video',
      visibility: { state: 'online' },
    };
    // `source.encode` est construit d'un bloc, plus bas : l'URL et les
    // réglages de transcription sont deux faces du MÊME champ, et c'est de les
    // avoir écrits à deux endroits que venait le refus.
    const encodeSource: Record<string, unknown> = {};
    if (input.sourceUrl) encodeSource.media_url = input.sourceUrl;
    if (input.description) payload.description = input.description;

    if (input.pseudo || input.alias) {
      payload.customs = [
        ...(input.pseudo ? [{ name: 'pseudo', value: input.pseudo, public: true }] : []),
        ...(input.alias ? [{ name: 'alias', value: input.alias, public: true }] : []),
      ];
    }
    const tagIds = (input.tagIds || []).filter(t => t != null);
    if (tagIds.length) payload.tag_ids = tagIds;
    // Un média peut appartenir à plusieurs playlists (session, joueur,
    // question). On déduplique : la même playlist envoyée deux fois est au
    // mieux inutile, au pire refusée.
    //
    // `position` est OBLIGATOIRE et commence à 1. L'ordre est celui de
    // l'appelant : il connaît la hiérarchie de son rangement, nous non.
    const playlists = [...new Set(
      [...(input.playlistIds || []), input.playlistId]
        .filter((p): p is string | number => p != null && p !== '')
        .map(String),
    )];
    if (playlists.length) {
      payload.playlists = playlists.map((id, index) => ({ id, position: index + 1 }));
    }

    // Transcription à l'encodage, DANS `source.encode` — au même endroit que
    // l'URL, parce que c'est le même champ. Les mêmes clés que
    // {@link uploadMedia} (confirmées sur un appel réel côté multipart), mais
    // imbriquées : le multipart énumère des chemins de champ, le JSON porte la
    // structure que ces chemins décrivent.
    //
    // `speechToText` en chaîne reste le déclencheur historique de cet appel :
    // sans lui ni `encode`, on n'émet aucune clé de transcription — c'est le
    // comportement que `server.js` connaît depuis toujours pour les médias
    // encodés depuis une URL.
    const legacyLang = typeof input.speechToText === 'string' ? input.speechToText.trim() : '';
    const wantsEncodeKeys = !!legacyLang || !!input.encode || !!this.config.encode;
    if (wantsEncodeKeys) {
      const encode = resolveEncode(
        this.config.encode,
        legacyLang ? { speechToText: true, speechToTextLanguage: legacyLang } : undefined,
        input.encode,
      );
      if (encode.speechToText) {
        encodeSource.speech_to_text = {
          type: 'subtitle_transcript',
          automatic_translation: encode.automaticTranslation,
          language: encode.speechToTextLanguage,
        };
      }
      // Émis seulement s'il est demandé, jamais à `false`. C'est la règle du
      // multipart, et elle vaut ici : l'API lit la PRÉSENCE du champ, pas sa
      // valeur — un `false` explicite activerait le passthru tout en donnant
      // l'impression de l'avoir coupé.
      //
      // Cette voie ne l'émettait pas du tout : un `encodingPassthru` réglé
      // dans l'application ne franchissait que le chemin multipart, et les
      // vidéos encodées depuis une URL attendaient un ré-encodage complet sans
      // que rien ne le signale.
      if (encode.encodingPassthru) encodeSource.encoding_passthru = true;
    }

    // Émis seulement s'il y a quelque chose dedans : un `source: {}` serait un
    // champ déclaré vide, ce que l'API lit comme une source invalide et non
    // comme une absence.
    if (Object.keys(encodeSource).length) payload.source = { encode: encodeSource };

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
        ...(input.pseudo ? [{ name: 'pseudo', value: input.pseudo, public: true }] : []),
        ...(input.alias ? [{ name: 'alias', value: input.alias, public: true }] : []),
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

    // Réglages d'encodage. Ils étaient en dur ici : toute borne installée
    // produisait des sous-titres français, quelle que soit la langue parlée.
    const encode = resolveEncode(this.config.encode, input.encode);
    // Passthru : la source est déjà dans un format lisible tel quel, inutile
    // de la ré-encoder — accélère la disponibilité de la vidéo après upload.
    if (encode.encodingPassthru) body.append('source[encode][encoding_passthru]', '1');
    if (encode.speechToText) {
      body.append('source[encode][speech_to_text][type]', 'subtitle_transcript');
      body.append('source[encode][speech_to_text][automatic_translation]', String(encode.automaticTranslation));
      body.append('source[encode][speech_to_text][language]', encode.speechToTextLanguage);
    }

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
    if (input.encodingVersion != null) params.set('source.encoding_version', String(input.encodingVersion));
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
   * Une page de `GET /organization/playlists`.
   *
   * La réponse porte, pour chaque playlist, sa description, ses champs
   * personnalisés ET les vues auxquelles elle est rattachée. C'est ce qui
   * permet de reconstruire un classement entier (« toutes les questions »,
   * « tous les joueurs ») avec une requête au lieu d'un détail par playlist.
   */
  private async playlistPage(input: { search?: string; offset?: number; limit?: number }): Promise<{ rows: PlaylistRow[]; total: number }> {
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const limit = Math.max(1, Math.floor(input.limit ?? 100));
    const params = new URLSearchParams({ range: `${offset}-${offset + limit - 1}` });
    if (input.search) params.set('search', input.search);
    const body = await apiFetch(
      `${this.baseUrl}/organization/playlists?${params.toString()}`,
      { method: 'GET', headers: this.authHeaders() },
      'streamlike/listPlaylists',
    );
    const raw = Array.isArray(body?.data) ? body.data : (Array.isArray(body) ? body : []);
    const rows = raw.filter((r: any) => r && r.id).map(normalizePlaylist);
    return { rows, total: Number(body?.total_count ?? rows.length) || rows.length };
  }

  /** Une page de playlists (défaut : les 100 premières). */
  async listPlaylists(input: { search?: string; offset?: number; limit?: number } = {}): Promise<PlaylistRow[]> {
    const { rows } = await this.playlistPage(input);
    return rows;
  }

  /**
   * Toutes les playlists du compte, pages enchaînées jusqu'à `total_count`.
   *
   * Le plafond de pages évite qu'un compte inattendu (ou un `total_count`
   * fantaisiste) fasse tourner la boucle indéfiniment sur le chemin d'une
   * requête admin.
   */
  async listAllPlaylists(input: { search?: string; pageSize?: number } = {}): Promise<PlaylistRow[]> {
    const limit = Math.max(1, Math.floor(input.pageSize ?? 200));
    const out: PlaylistRow[] = [];
    let total = Infinity;
    for (let page = 0; page < 25 && out.length < total; page += 1) {
      const res = await this.playlistPage({ search: input.search, offset: out.length, limit });
      total = res.total;
      if (!res.rows.length) break;
      out.push(...res.rows);
    }
    return out;
  }

  async getPlaylist(playlistId: string): Promise<PlaylistRow> {
    const r = await apiFetch(
      `${this.baseUrl}/organization/playlists/${encodeURIComponent(playlistId)}`,
      { method: 'GET', headers: this.authHeaders() },
      'streamlike/getPlaylist',
    );
    if (!r || !r.id) throw new Error(`Playlist non trouvée : ${playlistId}`);
    return normalizePlaylist(r);
  }

  /** Édite nom, description et champs personnalisés d'une playlist. */
  async updatePlaylist(playlistId: string, patch: Partial<PlaylistInput>): Promise<void> {
    const payload: Record<string, unknown> = {};
    if (patch.name != null) payload.name = patch.name;
    if (patch.description != null) payload.description = patch.description;
    // `custom_fields` REMPLACE l'ensemble : l'appelant réécrit tous les champs
    // qu'il veut conserver, sinon changer la durée effacerait la catégorie.
    if (patch.customs) payload.custom_fields = customsPayload(patch.customs, false);
    await apiFetch(
      `${this.baseUrl}/organization/playlists/${encodeURIComponent(playlistId)}`,
      {
        method: 'PATCH',
        headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      'streamlike/updatePlaylist',
    );
  }

  async deletePlaylist(playlistId: string): Promise<void> {
    await apiFetch(
      `${this.baseUrl}/organization/playlists/${encodeURIComponent(playlistId)}`,
      { method: 'DELETE', headers: this.authHeaders() },
      'streamlike/deletePlaylist',
    );
  }

  /**
   * Range un média déjà créé dans une playlist (ou l'en retire).
   *
   * Voie de rattrapage : à la création d'un média, les playlists partent dans
   * le même appel. Ici on répare après coup — un média envoyé pendant que sa
   * playlist n'existait pas encore, ou reclassé depuis la console.
   */
  async setMediaPlaylist(mediaId: string, playlistId: string, remove = false): Promise<void> {
    const params = new URLSearchParams({ playlist_id: String(playlistId) });
    if (remove) params.set('remove', 'true');
    await apiFetch(
      `${this.baseUrl}/medias/${encodeURIComponent(mediaId)}/actions/organization/playlist?${params.toString()}`,
      { method: 'POST', headers: this.authHeaders() },
      'streamlike/setMediaPlaylist',
    );
  }

  /**
   * Liste les vues de l'organisation (`GET /organization/views`).
   *
   * Une vue est un regroupement ORDONNÉ de playlists : c'est elle qui donne
   * leur sens aux playlists (« celles-ci sont des questions », « celles-là des
   * joueurs »), et la position d'une playlist dans la vue fait l'ordre.
   */
  async listViews(): Promise<ViewRow[]> {
    const body = await apiFetch(
      `${this.baseUrl}/organization/views?range=0-99`,
      { method: 'GET', headers: this.authHeaders() },
      'streamlike/listViews',
    );
    const rows = Array.isArray(body?.data) ? body.data : (Array.isArray(body) ? body : []);
    return rows.filter((r: any) => r && r.id).map(normalizeView);
  }

  async getView(viewId: string): Promise<ViewRow> {
    const r = await apiFetch(
      `${this.baseUrl}/organization/views/${encodeURIComponent(viewId)}`,
      { method: 'GET', headers: this.authHeaders() },
      'streamlike/getView',
    );
    if (!r || !r.id) throw new Error(`Vue non trouvée : ${viewId}`);
    return normalizeView(r);
  }

  /**
   * Réécrit la liste ORDONNÉE des playlists d'une vue.
   *
   * Il n'existe pas d'endpoint additif : `PATCH /organization/views/{id}`
   * remplace tout le tableau. Cette méthode est donc la primitive de base —
   * rattacher, détacher et réordonner en découlent. L'appelant est responsable
   * de sérialiser les appels concurrents sur une même vue : deux
   * lecture-modification-écriture en parallèle s'écraseraient l'une l'autre.
   */
  async setViewPlaylists(viewId: string, playlistIds: Array<string | number>): Promise<void> {
    // `position` est obligatoire (sinon `MANDATORY_PLAYLIST_POSITION`) et porte
    // l'ordre des playlists dans la vue, donc l'ordre des questions. Un tableau
    // vide vide la vue.
    const playlists = [...new Set(playlistIds.map(String))].map((id, index) => ({ id, position: index + 1 }));
    await apiFetch(
      `${this.baseUrl}/organization/views/${encodeURIComponent(viewId)}`,
      {
        method: 'PATCH',
        headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ playlists }),
      },
      'streamlike/patchView',
    );
  }

  /** Rattache une playlist à une vue, à la fin. No-op si elle y figure déjà. */
  async addPlaylistToView(viewId: string, playlistId: string): Promise<void> {
    const view = await this.getView(viewId);
    const current = view.playlists.map(p => p.id);
    if (current.includes(String(playlistId))) return;
    await this.setViewPlaylists(viewId, [...current, String(playlistId)]);
  }

  /** Détache une playlist d'une vue sans la supprimer du compte. */
  async removePlaylistFromView(viewId: string, playlistId: string): Promise<void> {
    const view = await this.getView(viewId);
    const current = view.playlists.map(p => p.id);
    if (!current.includes(String(playlistId))) return;
    await this.setViewPlaylists(viewId, current.filter(id => id !== String(playlistId)));
  }

  /**
   * Édite les champs personnalisés d'un média (pseudo et alias).
   */
  async updateMediaCustoms(mediaId: string, pseudo: string, alias: string): Promise<any> {
    const customs = [];
    if (pseudo != null) customs.push({ name: 'pseudo', value: pseudo,public:true });
    if (alias != null) customs.push({ name: 'alias', value: alias,public:true });
    
    return apiFetch(
      `${this.baseUrl}/medias/${encodeURIComponent(mediaId)}`,
      {
        method: 'PATCH',
        headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ customs, customs_merge: true }),
      },
      'streamlike/updateMediaCustoms',
    );
  }

  /**
   * Change l'état de publication d'un média.
   *
   * `offline` le retire de la diffusion sans rien détruire : c'est ce qui rend
   * une suppression rattrapable, là où un DELETE ne laisse aucun recours. Même
   * forme que {@link updateMediaCustoms} (PATCH + corps JSON) et même clé
   * `visibility.state` que celle posée à la création par {@link createMedia}.
   */
  async setMediaVisibility(mediaId: string, state: MediaVisibility): Promise<any> {
    return apiFetch(
      `${this.baseUrl}/medias/${encodeURIComponent(mediaId)}`,
      {
        method: 'PATCH',
        headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility: { state } }),
      },
      'streamlike/setMediaVisibility',
    );
  }

  /**
   * Le média tel que l'API le rend : champs personnalisés, playlists, tags,
   * visibilité, source. La réponse n'est pas enveloppée dans `data`, à la
   * différence des collections.
   *
   * `fields` restreint la réponse (`fields[]=a&fields[]=b` — la forme `a,b`
   * vaut `INVALID_FIELDS`). C'est aussi la SEULE façon d'obtenir
   * `source.is_cold_archived` : voir {@link isColdArchived}.
   */
  async getMedia(mediaId: string, options: { fields?: string[] } = {}): Promise<any> {
    const params = new URLSearchParams();
    for (const f of options.fields || []) if (f) params.append('fields[]', f);
    const qs = params.toString();
    return apiFetch(`${this.baseUrl}/medias/${encodeURIComponent(mediaId)}${qs ? `?${qs}` : ''}`, {
      method: 'GET',
      headers: this.authHeaders(),
    }, 'streamlike/getMedia');
  }

  /**
   * La source n'existe-t-elle plus que dans l'archive froide ?
   *
   * À demander juste avant de proposer un ré-encodage, une duplication ou un
   * export FTP : l'opération commence alors par une RESTAURATION de 3 à 5 h,
   * que rien ne signale sinon. `source.is_cold_archived` (API 5.31) n'est servi
   * que sur un média nommé ET demandé dans `fields[]` — jamais dans le payload
   * complet, jamais en listing — parce que répondre lit le stockage du média.
   * Un serveur qui ne connaît pas encore le champ ne le rend pas : `false`.
   */
  async isColdArchived(mediaId: string): Promise<boolean> {
    const media = await this.getMedia(mediaId, { fields: ['source.is_cold_archived'] });
    return media?.source?.is_cold_archived === true;
  }

  /** Lit et normalise le statut d'encodage d'un média. */
  async getEncodingStatus(mediaId: string): Promise<EncodingStatusResult> {
    const media = await this.getMedia(mediaId);
    const source = media?.source ?? {};
    const status = source.encoding_status
      || media?.['source.encoding_status']
      || 'unknown';
    const isEncoded = Boolean(
      source.is_encoded ?? media?.['source.is_encoded'] ?? (status === 'done'),
    );
    // Clés ABSENTES quand elles ne s'appliquent pas, jamais `null` ni `0` :
    // `encoding_version` manque sur un média qui ne publie rien, et ce n'est
    // pas l'encodeur historique.
    const version = Number(source.encoding_version);
    return {
      status,
      isEncoded,
      operationRunning: source.encoding_operation_running === true,
      restoring: source.has_operation === true,
      encodingVersion: version === 1 || version === 2 ? version : null,
      raw: media,
    };
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
   * Corps JSON, comme {@link createMedia} : description et champs personnalisés
   * sont bien pris dès la création. Les passer en query ferait échouer l'appel.
   */
  async createPlaylist(input: PlaylistInput): Promise<string | null> {
    const payload: Record<string, unknown> = { name: input.name };
    if (input.description) payload.description = input.description;
    if (input.customs?.length) payload.custom_fields = customsPayload(input.customs, false);
    const created = await apiFetch(
      `${this.baseUrl}/organization/playlists`,
      {
        method: 'POST',
        headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      'streamlike/createPlaylist',
    );
    const id = created?.id ?? created?.playlist_id ?? null;
    return id == null ? null : String(id);
  }

  /**
   * Cherche des playlists par nom (`GET /organization/playlists?search=`).
   *
   * `search` est un plein texte, pas une égalité : l'appelant doit encore
   * comparer les noms s'il cherche une playlist précise.
   */
  searchPlaylists(name: string): Promise<PlaylistRow[]> {
    return this.listPlaylists({ search: name });
  }

  /**
   * Pistes audio déclarées sur un média (`GET /medias/{id}/audio-tracks`).
   *
   * API **5.30** (en production depuis le 11 septembre 2026 — les numéros
   * 5.31 à 5.57 que cette lib a cités n'ont jamais atteint un serveur, tout
   * est sorti en une fois). `getMedia()` rend aussi `source.audio_tracks`, en
   * lecture seule et sur un média à la fois ; côté webservices,
   * `WsMedia.audioTracks` porte la même liste sans jeton. Le drapeau
   * `is_multiple_audio`, lui, existe depuis bien plus longtemps : pour savoir
   * simplement s'il y a plusieurs pistes, c'est la question la moins chère.
   *
   * Une langue s'adresse par jeton : le code ISO 639-1 nu, ou suffixé `-ad`
   * pour l'audiodescription (`-cc` pour les sous-titres pour sourds).
   *
   * Contrairement au reste de l'API, cette réponse ENVOIE ses `null`.
   */
  async getAudioTracks(mediaId: string): Promise<any> {
    return apiFetch(`${this.baseUrl}/medias/${encodeURIComponent(mediaId)}/audio-tracks`, {
      method: 'GET',
      headers: this.authHeaders(),
    }, 'streamlike/getAudioTracks');
  }

  /**
   * Crée un jeton de lecture pour UN média protégé.
   *
   * À émettre **par demande de lecture**, après notre propre contrôle
   * d'autorisation, et à passer au player en `sltoken=`. Le jeton est lié à une
   * IP, un user-agent et une fenêtre de temps : le réémettre est normal, le
   * mettre en cache pour plusieurs spectateurs ne l'est pas.
   *
   * Les valeurs par défaut (`0.0.0.0`, un user-agent générique) désactivent de
   * fait ces liens — pratique en recette, à ne pas laisser en production, où
   * l'IP et le user-agent du spectateur sont justement ce qui donne sa valeur
   * au jeton.
   */
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
        try {
          onUpdate({
            status: 'polling_error', isEncoded: false, operationRunning: false, restoring: false,
            encodingVersion: null, raw: { error: (err as Error).message },
          });
        } catch { /* noop */ }
      }
      if (Date.now() - startedAt > timeoutMs) {
        stopped = true;
        try {
          onUpdate({ status: 'timeout', isEncoded: false, operationRunning: false, restoring: false, encodingVersion: null, raw: {} });
        } catch { /* noop */ }
        return;
      }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    };

    timer = setTimeout(tick, intervalMs);
    return { cancel() { stopped = true; if (timer) clearTimeout(timer); } };
  }
}
