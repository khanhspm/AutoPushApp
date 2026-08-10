import crypto from 'node:crypto';

import { FastifyReply, FastifyRequest } from 'fastify';

function tokensEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function createAdminAuthHook(expectedToken: string) {
  return async function authenticateAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    reply.header('Cache-Control', 'no-store');

    const authorization = request.headers.authorization;
    const [scheme, token, ...extra] = authorization?.split(' ') ?? [];

    if (scheme !== 'Bearer' || !token || extra.length > 0 || !tokensEqual(token, expectedToken)) {
      await reply.code(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'A valid CMS admin token is required',
        },
      });
    }
  };
}
