import { createHmac, timingSafeEqual } from "node:crypto";

const SHA256_SIGNATURE_PATTERN = /^sha256=[a-f0-9]{64}$/i;

/** Verify GitHub's HMAC-SHA256 signature against the exact raw request body. */
export function verifyGithubSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader || !SHA256_SIGNATURE_PATTERN.test(signatureHeader)) return false;

  const providedDigest = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  const expectedDigest = createHmac("sha256", secret).update(rawBody).digest();

  return providedDigest.length === expectedDigest.length && timingSafeEqual(providedDigest, expectedDigest);
}

