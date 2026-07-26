import { apiFetch } from './http';
import type {
  StreamlikeConfig,
  CreateMediaInput,
  EncodingStatusResult,
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

  /** Crée un média en encodant depuis `sourceUrl` (paramètres en QUERY). */
  createMedia(input: CreateMediaInput): Promise<any> {
    const params = new URLSearchParams();
    params.set('name', input.name);
    params.set('permalink', input.permalink);
    params.set('type', input.type || 'vod');
    if (input.sourceUrl) params.set('source', input.sourceUrl);
    if (input.description) params.set('description', input.description);
    for (const t of input.tagIds || []) if (t != null) params.append('tag_ids[]', String(t));
    if (input.playlistId != null) params.append('playlists[]', String(input.playlistId));

    return apiFetch(`${this.baseUrl}/medias?${params.toString()}`, {
      method: 'POST',
      headers: this.authHeaders(),
    }, 'streamlike/createMedia');
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
      `${this.baseUrl}/organization/tags?name=${encodeURIComponent(name)}`,
      { method: 'POST', headers: this.authHeaders() },
      'streamlike/createTag',
    );
    return created?.id ?? created?.tag_id ?? created?.permalink ?? null;
  }

  /** Crée un token de lecture (player protégé). */
  createPlaybackToken(
    mediaId: string,
    opts: { expireAt: string; ip?: string; userAgent?: string },
  ): Promise<any> {
    const params = new URLSearchParams({
      expire_at: opts.expireAt,
      ip: opts.ip || '0.0.0.0',
      user_agent: opts.userAgent || 'secure-upload-player',
    });
    return apiFetch(
      `${this.baseUrl}/medias/${encodeURIComponent(mediaId)}/token?${params.toString()}`,
      { method: 'POST', headers: this.authHeaders() },
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
