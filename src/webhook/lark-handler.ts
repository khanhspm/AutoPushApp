import crypto from 'node:crypto';

import { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { buildCommandHelp, extractLarkTextContent, parseBuildCommand } from '../commands/build-command';
import { env } from '../config/env';
import { AppError } from '../http/errors';
import { BuildRequestService } from '../services/build-request-service';
import { sendLarkTextMessage } from '../services/lark-service';
import { logger } from '../utils/logger';
import { verifyLarkSignature } from './signature-verify';

const larkWebhookSchema = z.object({
  type: z.string().optional(),
  token: z.string().optional(),
  challenge: z.string().optional(),
  header: z
    .object({
      event_type: z.string().optional(),
      event_id: z.string().optional(),
    })
    .optional(),
  event: z
    .object({
      sender: z
        .object({
          sender_id: z
            .object({
              open_id: z.string().optional(),
              union_id: z.string().optional(),
              user_id: z.string().optional(),
            })
            .optional(),
        })
        .optional(),
      message: z
        .object({
          message_id: z.string().optional(),
          chat_id: z.string().optional(),
          content: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

type LarkWebhookBody = z.infer<typeof larkWebhookSchema>;

function userIdFromBody(body: LarkWebhookBody): string {
  const senderId = body.event?.sender?.sender_id;
  return senderId?.open_id ?? senderId?.union_id ?? senderId?.user_id ?? '';
}

function requestRawBody(request: FastifyRequest): string {
  const rawBody = (request as FastifyRequest & { rawBody?: string | Buffer }).rawBody;
  return Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody ?? JSON.stringify(request.body ?? {});
}

function hasFreshTimestamp(request: FastifyRequest): boolean {
  const header = request.headers['x-lark-request-timestamp'];
  const value = Array.isArray(header) ? header[0] : header;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && Math.abs(Date.now() / 1000 - timestamp) <= 5 * 60;
}

async function sendTextSafely(chatId: string, message: string): Promise<void> {
  try {
    await sendLarkTextMessage(chatId, message);
  } catch (error) {
    logger.error({ chatId, error }, 'Failed to send Lark text message');
  }
}

function idempotencyKey(body: LarkWebhookBody, rawBody: string, userId: string, chatId: string): string {
  const eventId = body.header?.event_id ?? body.event?.message?.message_id;
  if (eventId) {
    return `lark:${eventId}`;
  }

  return `lark:${crypto.createHash('sha256').update(`${userId}:${chatId}:${rawBody}`).digest('hex')}`;
}

export function createLarkWebhookHandler(buildRequests: BuildRequestService) {
  return async function handleLarkWebhook(request: FastifyRequest, reply: FastifyReply) {
    const parsed = larkWebhookSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid Lark webhook payload' });
    }
    const body = parsed.data;

    if (body.type === 'url_verification') {
      if (env.LARK_VERIFICATION_TOKEN && body.token !== env.LARK_VERIFICATION_TOKEN) {
        return reply.code(403).send({ error: 'Invalid Lark verification token' });
      }
      return reply.send({ challenge: body.challenge });
    }

    const rawBody = requestRawBody(request);
    if (env.LARK_ENCRYPT_KEY) {
      if (!hasFreshTimestamp(request)) {
        return reply.code(401).send({ error: 'Expired Lark request timestamp' });
      }

      const signatureValid = verifyLarkSignature({
        timestamp: request.headers['x-lark-request-timestamp'],
        nonce: request.headers['x-lark-request-nonce'],
        signature: request.headers['x-lark-signature'],
        body: rawBody,
        encryptKey: env.LARK_ENCRYPT_KEY,
      });
      if (!signatureValid) {
        return reply.code(401).send({ error: 'Invalid Lark signature' });
      }
    } else if (env.NODE_ENV === 'production') {
      logger.warn('LARK_ENCRYPT_KEY is not configured; webhook signature verification is disabled.');
    }

    if (body.header?.event_type !== 'im.message.receive_v1') {
      return reply.send({ ok: true, ignored: true });
    }

    const chatId = body.event?.message?.chat_id;
    const userId = userIdFromBody(body);
    if (!chatId || !userId) {
      return reply.code(400).send({ error: 'Missing chat_id or sender_id in Lark event' });
    }

    const command = parseBuildCommand(extractLarkTextContent(body.event?.message?.content));
    if (!command) {
      await sendTextSafely(chatId, `❌ Lệnh build không hợp lệ. ${buildCommandHelp()}`);
      return reply.send({ ok: true, validCommand: false });
    }

    logger.info({ chatId, userId, projectKey: command.projectId }, 'Received Lark build command');

    try {
      const result = await buildRequests.submit({
        projectKey: command.projectId,
        appVersion: command.appVersion,
        buildNumber: command.buildNumber,
        releaseNotes: command.releaseNotes,
        source: 'lark',
        requestedBy: userId,
        chatId,
        idempotencyKey: idempotencyKey(body, rawBody, userId, chatId),
      });

      return reply.send({ ok: true, buildId: result.build.id, duplicate: !result.created });
    } catch (error) {
      if (error instanceof AppError && [400, 403, 404, 409].includes(error.statusCode)) {
        await sendTextSafely(chatId, `❌ ${error.message}`);
        return reply.send({ ok: true, accepted: false, code: error.code });
      }
      throw error;
    }
  };
}
