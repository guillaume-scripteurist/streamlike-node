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
  playlistId?: string | number;
  description?: string;
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
