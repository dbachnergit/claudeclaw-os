import { SignJWT, importPKCS8 } from 'jose';

export interface AscCredentials {
  issuerId: string;
  keyId: string;
  privateKeyPem: string;
}

export async function signAscJwt(creds: AscCredentials, lifetimeSec = 1200): Promise<string> {
  const key = await importPKCS8(creds.privateKeyPem, 'ES256');
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: creds.keyId, typ: 'JWT' })
    .setIssuer(creds.issuerId)
    .setIssuedAt(now)
    .setExpirationTime(now + lifetimeSec)
    .setAudience('appstoreconnect-v1')
    .sign(key);
}
