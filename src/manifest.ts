/**
 * Du média au flux jouable, pour un player qui n'est pas celui de Streamlike.
 *
 * `/ws/media` rend `manifestUrl` : un index JSON de TOUS les fichiers encodés.
 * On y trouve le master HLS — celui qu'on donne à ExoPlayer ou AVPlayer — mais
 * il ne s'annonce pas par son nom. Il se reconnaît à son débit : **l'entrée
 * dont `globalbitrate` vaut 0 est le master adaptatif**, les autres sont des
 * rendus isolés. Prendre la première de la liste, ou la plus grosse, donne un
 * player bloqué sur une seule qualité — ce qui « marche » au bureau et casse
 * sur le réseau d'une salle.
 *
 * L'autre voie, `/ws/manifest`, rend la même chose mais exige une IP
 * autorisée. `manifestUrl` non : c'est presque toujours la bonne porte.
 */
import { STREAMLIKE_CDN } from './webservices';
import { WebserviceError } from './http';

/** Un fichier encodé, tel que le manifeste le décrit. */
export interface Rendition {
  /** Débit global en kbps. **0 désigne le master adaptatif**, pas un fichier muet. */
  bitrate: number;
  /** Valeurs de l'encodeur, pas la résolution d'affichage. */
  width: number;
  height: number;
  /** URL absolue en https (les URL du manifeste sont relatives au protocole). */
  url: string;
  /** Groupe d'origine : `idevicev2`, `mp4`, `mp4low`, … */
  group: string;
}

export interface ResolvedStreams {
  /** Master HLS adaptatif, ou `null` si le média n'en publie pas. */
  hlsMaster: string | null;
  /** Rendus HLS isolés (`idevicev2`), master exclu, du plus léger au plus lourd. */
  hlsRenditions: Rendition[];
  /** Fichiers progressifs (`mp4`, `mp4low`, `webm`), du plus léger au plus lourd. */
  progressive: Rendition[];
  /** Tout, à plat, pour les groupes qu'on n'a pas nommés. */
  all: Rendition[];
}

/** Les URL du manifeste sont en `//cfcdn…` : sans préfixe, elles cassent hors navigateur. */
function absolute(url: unknown): string {
  const value = String(url ?? '').trim();
  if (!value) return '';
  if (value.startsWith('//')) return `https:${value}`;
  return value;
}

/** Groupes HLS, du plus récent au plus ancien. `idevicev1` reste servi sur les vieux médias. */
const HLS_GROUPS = ['idevicev2', 'idevicev1'];
const PROGRESSIVE_GROUPS = ['mp4', 'mp4low', 'webm'];

/**
 * Lit un manifeste déjà téléchargé.
 *
 * Séparé du téléchargement à dessein : le manifeste se met en cache, et le
 * relire ne doit pas coûter un appel réseau.
 */
export function parseManifest(manifest: any): ResolvedStreams {
  const all: Rendition[] = [];
  for (const [group, entries] of Object.entries(manifest || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const url = absolute((entry as any)?.url);
      if (!url) continue;
      all.push({
        bitrate: Number((entry as any).globalbitrate) || 0,
        width: Number((entry as any).width) || 0,
        height: Number((entry as any).height) || 0,
        url,
        group,
      });
    }
  }

  const byBitrate = (a: Rendition, b: Rendition) => a.bitrate - b.bitrate;
  const hls = all.filter(r => HLS_GROUPS.includes(r.group));
  const master = hls.find(r => r.bitrate === 0) ?? null;

  return {
    hlsMaster: master?.url ?? null,
    hlsRenditions: hls.filter(r => r.bitrate > 0).sort(byBitrate),
    progressive: all.filter(r => PROGRESSIVE_GROUPS.includes(r.group)).sort(byBitrate),
    all,
  };
}

/** Télécharge puis lit le manifeste pointé par `WsMedia.manifestUrl`. */
export async function fetchStreams(
  manifestUrl: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<ResolvedStreams> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = absolute(manifestUrl);
  if (!url) throw new WebserviceError('manifest', null, 'URL de manifeste vide');
  const init: RequestInit = { method: 'GET' };
  if (options.timeoutMs && typeof AbortSignal?.timeout === 'function') {
    init.signal = AbortSignal.timeout(options.timeoutMs);
  }
  const res = await doFetch(url, init);
  if (!res.ok) throw new WebserviceError('manifest', res.status, `Manifeste HTTP ${res.status}`);
  return parseManifest(await res.json());
}

/**
 * URL de redirection vers le meilleur fichier pour une taille cible.
 *
 * La plateforme répond 302 vers le fichier retenu. **Sans `width`/`height`, un
 * `hls` rend UN rendu, pas le master adaptatif** — le player restera sur une
 * seule qualité. Pour du natif adaptatif, passer par {@link fetchStreams}.
 */
export function directFileUrl(input: {
  type: 'hls' | 'idevicev2' | 'idevicev1' | 'mp4' | 'mp4low' | 'webm' | 'mp3' | 'aac';
  mediaId?: string;
  permalink?: string;
  width?: number;
  height?: number;
  baseUrl?: string;
}): string {
  const base = (input.baseUrl || STREAMLIKE_CDN).replace(/\/+$/, '');
  const ref = input.mediaId
    ? `media_id/${encodeURIComponent(input.mediaId)}`
    : `permalink/${encodeURIComponent(String(input.permalink ?? ''))}`;
  const size = input.width && input.height
    ? `/width/${Math.round(input.width)}/height/${Math.round(input.height)}`
    : '';
  return `${base}/html5/${input.type}/${ref}${size}`;
}
