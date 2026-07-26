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
