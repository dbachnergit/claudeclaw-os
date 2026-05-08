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

  async listBetaFeedback(): Promise<AscResource[]> {
    const json = await this.getJson<{ data: AscResource[] }>('/betaFeedbackScreenshotSubmissions');
    return json.data;
  }

  async listBetaCrashFeedback(): Promise<AscResource[]> {
    const json = await this.getJson<{ data: AscResource[] }>('/betaFeedbackCrashSubmissions');
    return json.data;
  }

  async listCustomerReviews(appId: string): Promise<AscResource[]> {
    const json = await this.getJson<{ data: AscResource[] }>(`/apps/${appId}/customerReviews`);
    return json.data;
  }
}
