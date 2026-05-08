import { describe, it, expect, vi } from 'vitest';
import { AscClient } from '../client.js';

describe('AscClient', () => {
  it('signs each request with a fresh JWT and returns the parsed paged response', async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        data: [{ id: 'F1', type: 'betaFeedbackScreenshotSubmissions' }],
        included: [{ id: 'B1', type: 'builds', attributes: { version: '99' } }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const tokenStub = vi.fn().mockResolvedValue('signed.jwt.value');

    const client = new AscClient({ getToken: tokenStub, fetch: fetchStub as any });
    const response = await client.listBetaFeedback('APP123');

    expect(response.data).toEqual([{ id: 'F1', type: 'betaFeedbackScreenshotSubmissions' }]);
    expect(response.included?.[0]).toEqual({ id: 'B1', type: 'builds', attributes: { version: '99' } });
    expect(tokenStub).toHaveBeenCalledOnce();
    const [url, init] = fetchStub.mock.calls[0];
    // Apple's API requires the nested /apps/{id}/... path AND ?include=build
    // so the poller can resolve build versions without N+1 round trips.
    expect(url).toContain('https://api.appstoreconnect.apple.com/v1/apps/APP123/betaFeedbackScreenshotSubmissions');
    expect(url).toContain('include=build');
    expect((init.headers as Record<string,string>).Authorization).toBe('Bearer signed.jwt.value');
  });

  it('throws on non-2xx with status code in the message', async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      new Response('forbidden', { status: 403 })
    );
    const client = new AscClient({
      getToken: async () => 'tk',
      fetch: fetchStub as any,
    });
    await expect(client.listBetaFeedback('APP123')).rejects.toThrow(/403/);
  });
});
