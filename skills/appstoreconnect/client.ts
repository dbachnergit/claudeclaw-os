export interface AscClientOptions {
  getToken: () => Promise<string>;
  fetch?: typeof fetch;
  baseUrl?: string;
}

export interface AscResource<T = Record<string, unknown>> {
  id: string;
  type: string;
  attributes?: T;
  relationships?: Record<string, { data?: { id: string; type: string } | null; links?: unknown }>;
}

export interface AscPagedResponse {
  data: AscResource[];
  included?: AscResource[];
}

export class AscClient {
  private readonly fetch: typeof fetch;
  private readonly baseUrl: string;
  private readonly getToken: () => Promise<string>;

  constructor(opts: AscClientOptions) {
    this.fetch = opts.fetch ?? fetch;
    this.baseUrl = opts.baseUrl ?? 'https://api.appstoreconnect.apple.com/v1';
    this.getToken = opts.getToken;
  }

  private async getJson<T>(path: string): Promise<T> {
    const token = await this.getToken();
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ASC API ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  // Apple's API does NOT permit GET_COLLECTION on the top-level
  // /v1/betaFeedback{Screenshot,Crash}Submissions resources — only
  // GET_INSTANCE and DELETE. Collection access requires the nested
  // /v1/apps/{id}/... path. The original Phase 2 plan pre-dated this
  // restriction; verified empirically against the live API on 2026-05-08.
  //
  // ?include=build pulls the related `builds` resource into `included[]`
  // so the poller can resolve relationships.build.data.id -> attributes.version
  // (the human label like "96") without a per-item N+1 round trip.
  async listBetaFeedback(appId: string): Promise<AscPagedResponse> {
    return this.getJson<AscPagedResponse>(`/apps/${appId}/betaFeedbackScreenshotSubmissions?include=build`);
  }

  async listBetaCrashFeedback(appId: string): Promise<AscPagedResponse> {
    return this.getJson<AscPagedResponse>(`/apps/${appId}/betaFeedbackCrashSubmissions?include=build`);
  }

  // App Store reviews don't have a `build` relationship (they're tied to
  // appStoreVersion, not testflight builds). build_version stays empty for
  // these rows; the consumer can derive territory from the raw response.
  async listCustomerReviews(appId: string): Promise<AscPagedResponse> {
    return this.getJson<AscPagedResponse>(`/apps/${appId}/customerReviews`);
  }
}
