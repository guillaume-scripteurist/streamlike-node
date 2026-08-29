/** Erreur d'appel API (Mediatech ou Streamlike). */
export class ApiError extends Error {
  constructor(
    public readonly label: string,
    public readonly status: number | null,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
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
    throw new ApiError(label, res.status, `[${label}] HTTP ${res.status} : ${detail}`, body);
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
