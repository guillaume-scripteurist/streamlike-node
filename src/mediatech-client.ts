import { apiFetch } from './http';
import type {
  MediatechConfig,
  SignUploadInput,
  SignUploadResponse,
  CompleteUploadResponse,
} from './types';

/**
 * Client de l'« upload sécurisé » Mediatech (upload direct navigateur → GCS).
 * À utiliser côté serveur uniquement (détient le jeton API).
 *
 * Flux : `signUpload()` → le navigateur pousse les octets sur GCS →
 * `completeUpload()` → Mediatech rappelle ton `callbackUrl` avec l'URL MP4.
 */
export class MediatechUploadClient {
  private readonly baseUrl: string;

  constructor(private readonly config: MediatechConfig) {
    if (!config?.apiToken || !config?.accountId) {
      throw new Error('MediatechUploadClient: apiToken et accountId sont requis');
    }
    this.baseUrl = (config.baseUrl || 'https://api.mediatech.fr').replace(/\/$/, '');
  }

  private authHeader(): string {
    return `mediatechAuth token="${this.config.apiToken}"`;
  }

  /** STEP 1 — URL d'upload signée (serveur → serveur). */
  signUpload(input: SignUploadInput): Promise<SignUploadResponse> {
    const payload: Record<string, unknown> = {
      encrypted_account_id: this.config.accountId,
      filename: input.filename,
      content_type: input.contentType || 'video/webm',
      callback_url: input.callbackUrl,
    };
    if (input.maxBytes != null) payload.max_bytes = input.maxBytes;
    return apiFetch(`${this.baseUrl}/upload/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Mediatech-Authorization': this.authHeader() },
      body: JSON.stringify(payload),
    }, 'mediatech/sign');
  }

  /** STEP 2 — Notifie la fin de l'upload ; déclenche le callback Mediatech. */
  completeUpload(blobPath: string): Promise<CompleteUploadResponse> {
    return apiFetch(`${this.baseUrl}/upload/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Mediatech-Authorization': this.authHeader() },
      body: JSON.stringify({ encrypted_account_id: this.config.accountId, blob_path: blobPath }),
    }, 'mediatech/complete');
  }

  /** (Optionnel) Re-génère une URL de téléchargement signée fraîche. */
  refreshDownloadUrl(blobPath: string): Promise<{ download_url: string; [k: string]: unknown }> {
    return apiFetch(`${this.baseUrl}/upload/download_url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Mediatech-Authorization': this.authHeader() },
      body: JSON.stringify({ encrypted_account_id: this.config.accountId, blob_path: blobPath }),
    }, 'mediatech/download_url');
  }
}
