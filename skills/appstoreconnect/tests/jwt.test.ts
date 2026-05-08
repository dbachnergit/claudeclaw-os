import { describe, it, expect } from 'vitest';
import { signAscJwt, type AscCredentials } from '../jwt';
import { generateKeyPair, exportPKCS8 } from 'jose';

describe('signAscJwt', () => {
  it('returns a JWS with iss/iat/exp/aud claims', async () => {
    // jose v6: extractable must be true to allow exportPKCS8 in test setup
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const creds: AscCredentials = {
      issuerId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      keyId: 'ABCD1234EF',
      privateKeyPem: pem,
    };
    const token = await signAscJwt(creds);
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    expect(payload.iss).toBe(creds.issuerId);
    expect(payload.aud).toBe('appstoreconnect-v1');
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(20 * 60);
  });
});
