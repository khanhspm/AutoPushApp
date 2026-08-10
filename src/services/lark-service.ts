import { env } from '../config/env';
import { logger } from '../utils/logger';

interface TenantAccessTokenResponse {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
}

interface LarkApiResponse {
  code: number;
  msg: string;
  data?: unknown;
}

let cachedTenantToken: { token: string; expiresAt: number } | undefined;

function assertLarkConfigured(): void {
  if (!env.LARK_APP_ID || !env.LARK_APP_SECRET) {
    throw new Error('LARK_APP_ID and LARK_APP_SECRET must be configured before sending Lark messages.');
  }
}

async function requestTenantAccessToken(): Promise<string> {
  assertLarkConfigured();

  if (cachedTenantToken && cachedTenantToken.expiresAt > Date.now() + 60_000) {
    return cachedTenantToken.token;
  }

  const response = await fetch(`${env.LARK_API_BASE_URL}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      app_id: env.LARK_APP_ID,
      app_secret: env.LARK_APP_SECRET,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to request Lark tenant token: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as TenantAccessTokenResponse;

  if (payload.code !== 0 || !payload.tenant_access_token) {
    throw new Error(`Failed to request Lark tenant token: ${payload.msg}`);
  }

  cachedTenantToken = {
    token: payload.tenant_access_token,
    expiresAt: Date.now() + (payload.expire ?? 7200) * 1000,
  };

  return cachedTenantToken.token;
}

async function postMessage(chatId: string, msgType: string, content: unknown): Promise<void> {
  const tenantToken = await requestTenantAccessToken();
  const response = await fetch(`${env.LARK_API_BASE_URL}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tenantToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: msgType,
      content: JSON.stringify(content),
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to send Lark message: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as LarkApiResponse;

  if (payload.code !== 0) {
    throw new Error(`Failed to send Lark message: ${payload.msg}`);
  }

  logger.info({ chatId, msgType }, 'Sent Lark message');
}

export async function sendLarkTextMessage(chatId: string, text: string): Promise<void> {
  await postMessage(chatId, 'text', { text });
}

export async function sendLarkInteractiveCard(chatId: string, card: unknown): Promise<void> {
  await postMessage(chatId, 'interactive', card);
}
