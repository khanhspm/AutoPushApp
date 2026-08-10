import crypto from 'node:crypto';

export interface LarkSignatureInput {
  timestamp?: string | string[];
  nonce?: string | string[];
  signature?: string | string[];
  body: string;
  encryptKey?: string;
}

function headerValue(value?: string | string[]): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function createLarkSignature({ timestamp, nonce, body, encryptKey = '' }: LarkSignatureInput): string {
  const timestampValue = headerValue(timestamp) ?? '';
  const nonceValue = headerValue(nonce) ?? '';
  const content = `${timestampValue}${nonceValue}${encryptKey}${body}`;

  return crypto.createHash('sha256').update(content).digest('hex');
}

export function verifyLarkSignature(input: LarkSignatureInput): boolean {
  const signature = headerValue(input.signature);

  if (!signature || !input.timestamp || !input.nonce || !input.encryptKey) {
    return false;
  }

  return safeEqual(createLarkSignature(input), signature);
}
