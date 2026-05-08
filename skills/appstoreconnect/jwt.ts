import { SignJWT, importPKCS8 } from 'jose';

/** Apple's maximum permitted JWT lifetime for ASC API tokens (20 min). */
const ASC_MAX_JWT_LIFETIME_SEC = 1200;

export interface AscCredentials {
  issuerId: string;
  keyId: string;
  privateKeyPem: string;
}

export async function signAscJwt(creds: AscCredentials, lifetimeSec = ASC_MAX_JWT_LIFETIME_SEC): Promise<string> {
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
