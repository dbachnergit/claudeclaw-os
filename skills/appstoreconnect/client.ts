export interface AscClientOptions {
  getToken: () => Promise<string>;
  fetch?: typeof fetch;
  baseUrl?: string;
}

export interface AscResource<T = Record<string, unknown>> {
  id: string;
  type: string;
  attributes?: T;
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
  async listBetaFeedback(appId: string): Promise<AscResource[]> {
    const json = await this.getJson<{ data: AscResource[] }>(`/apps/${appId}/betaFeedbackScreenshotSubmissions`);
    return json.data;
  }

  async listBetaCrashFeedback(appId: string): Promise<AscResource[]> {
    const json = await this.getJson<{ data: AscResource[] }>(`/apps/${appId}/betaFeedbackCrashSubmissions`);
    return json.data;
  }

  async listCustomerReviews(appId: string): Promise<AscResource[]> {
    const json = await this.getJson<{ data: AscResource[] }>(`/apps/${appId}/customerReviews`);
    return json.data;
  }
}
