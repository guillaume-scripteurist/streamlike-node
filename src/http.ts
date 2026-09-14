/** Erreur d'appel API (Mediatech ou Streamlike). */
export class ApiError extends Error {
  constructor(
    public readonly label: string,
    public readonly status: number | null,
    message: string,
    public readonly body?: unknown,
    /**
     * Secondes à attendre avant de réessayer, lues dans l'en-tête
     * `Retry-After` d'un 429.
     *
     * Sans elle, un plafond de débit est indiscernable d'une panne : l'appelant
     * réessaie aussitôt, se refait refuser, et creuse le trou. Mediatech
     * plafonne notamment les URL d'upload signées **par compte et par heure** —
     * un refus qui concerne alors tout un événement, pas la personne qui l'a
     * déclenché.
     */
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Le refus vient-il d'un plafond de débit plutôt que d'une erreur de fond ? */
  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /**
   * Fenêtre de maintenance : **le seul 401 qui vaille un réessai.**
   *
   * Depuis l'API 5.30, une fenêtre annoncée ne ferme plus que les ÉCRITURES
   * (`POST`, `PATCH`, `DELETE`, et `GET /tools/shorturl` qui fabrique un lien) :
   * elles répondent `401` avec le message `API_OFFLINE` et n'écrivent rien.
   * Les lectures passent, les webservices n'ont jamais été concernés.
   *
   * Se distingue sur le MESSAGE, jamais sur le statut : tout autre 401 veut
   * dire que la clé est le problème, et le réessayer avec la même clé ne
   * réussira jamais. Une borne qui tombe ici garde sa file d'upload et la
   * vide quand la fenêtre se referme — elle ne réveille personne.
   */
  get isOffline(): boolean {
    if (this.status !== 401) return false;
    const message = this.body && typeof this.body === 'object'
      ? (this.body as { message?: unknown }).message
      : this.body;
    return typeof message === 'string' && message.toUpperCase().includes('API_OFFLINE');
  }

  /** Vaut-il la peine de réessayer plus tard, avec les mêmes identifiants ? */
  get isRetryable(): boolean {
    return this.isRateLimited || this.isOffline || (this.status != null && this.status >= 500) || this.status === null;
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}


/**
 * `Retry-After`, en secondes.
 *
 * L'en-tête admet deux formes — un nombre de secondes, ou une date HTTP. On
 * lit les deux : ne gérer que la première produit un `NaN` silencieux sur les
 * serveurs qui envoient la seconde, et l'appelant réessaie immédiatement,
 * c'est-à-dire exactement ce que le plafond cherchait à éviter.
 */
function parseRetryAfter(res: Response): number | undefined {
  const raw = res.headers?.get?.('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/** fetch avec gestion d'erreur uniforme (jette une {@link ApiError} si non-2xx). */
export async function apiFetch(url: string, options: RequestInit, label: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, options);
  } catch (networkErr) {
    throw new ApiError(label, null, `Échec réseau vers ${url} : ${(networkErr as Error).message}`);
  }
  const body = await readBody(res);
  if (!res.ok) {
    const detail =
      body && typeof body === 'object' && 'detail' in (body as any)
        ? JSON.stringify((body as any).detail)
        : (typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300));
    throw new ApiError(label, res.status, `[${label}] HTTP ${res.status} : ${detail}`, body, parseRetryAfter(res));
  }
  return body;
}

/**
 * Erreur d'un webservice `/ws/*`.
 *
 * Les webservices n'ont pas d'enveloppe d'erreur JSON : ils répondent **404
 * avec une page HTML** aussi bien pour un média inconnu que pour une valeur de
 * paramètre erronée ou une IP non autorisée. Le message ne dit donc jamais ce
 * qui s'est passé, et c'est exactement là que les journées se perdent — d'où
 * l'indice porté par {@link WebserviceError.hint}.
 */
export class WebserviceError extends ApiError {
  constructor(
    label: string,
    status: number | null,
    message: string,
    /** Piste de diagnostic, quand la forme de l'erreur en suggère une. */
    public readonly hint: string | null = null,
    body?: unknown,
  ) {
    super(label, status, message, body);
    this.name = 'WebserviceError';
  }
}

/** Services dont le refus vient le plus souvent de la liste blanche d'IP. */
const IP_GATED = new Set(['vote', 'manifest']);

/**
 * `GET` sur un webservice, avec le seul contrôle qui compte : **est-ce bien du
 * JSON ?**
 *
 * Un 404 arrive en `text/html`. Le passer à `JSON.parse` produit une
 * `SyntaxError` sur « `<` inattendu », qui ne dit rien de la cause réelle.
 */
export async function wsFetch(
  url: string,
  service: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<any> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const label = `ws/${service}`;
  const init: RequestInit = { method: 'GET', headers: { Accept: 'application/json' } };
  // `AbortSignal.timeout` existe depuis Node 17.3 ; on ne l'impose pas au cas
  // où la lib tournerait sur un portage sans lui (Workers anciens, Deno bridé).
  if (options.timeoutMs && typeof AbortSignal?.timeout === 'function') {
    init.signal = AbortSignal.timeout(options.timeoutMs);
  }

  let res: Response;
  try {
    res = await doFetch(url, init);
  } catch (networkErr) {
    throw new WebserviceError(label, null, `[${label}] échec réseau : ${(networkErr as Error).message}`);
  }

  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 404
      ? (IP_GATED.has(service)
        ? `${service} exige une IP serveur autorisée (back-office : Sécurité → Sécurité des webservices) ; un 404 ici veut le plus souvent dire « IP non autorisée », pas « introuvable ».`
        : 'Un 404 de webservice couvre aussi bien un identifiant inconnu qu\'une VALEUR de paramètre invalide (par exemple sortorder=desc au lieu de down).')
      : null;
    throw new WebserviceError(label, res.status, `[${label}] HTTP ${res.status}`, hint, text.slice(0, 300));
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new WebserviceError(
      label,
      res.status,
      `[${label}] réponse non-JSON (${text.slice(0, 80).replace(/\s+/g, ' ')}…)`,
      'Un 200 non-JSON signale en général un f= autre que json, ou une page d\'erreur servie en 200.',
      text.slice(0, 300),
    );
  }
}
