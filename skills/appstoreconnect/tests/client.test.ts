import { describe, it, expect, vi } from 'vitest';
import { AscClient } from '../client';

describe('AscClient', () => {
  it('signs each request with a fresh JWT and returns parsed JSON', async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'F1', type: 'betaFeedbackScreenshotSubmissions' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const tokenStub = vi.fn().mockResolvedValue('signed.jwt.value');

    const client = new AscClient({ getToken: tokenStub, fetch: fetchStub as any });
    const items = await client.listBetaFeedback('APP123');

    expect(items).toEqual([{ id: 'F1', type: 'betaFeedbackScreenshotSubmissions' }]);
    expect(tokenStub).toHaveBeenCalledOnce();
    const [url, init] = fetchStub.mock.calls[0];
    // Apple's API requires the nested /apps/{id}/... path for collection access.
    expect(url).toContain('https://api.appstoreconnect.apple.com/v1/apps/APP123/betaFeedbackScreenshotSubmissions');
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
