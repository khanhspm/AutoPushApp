import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import type { CmsAuthService } from '../services/cms-auth-service';

const emailBodySchema = z.object({ email: z.string() }).strict();
const idParamsSchema = z.object({ id: z.string().uuid() });
const statusBodySchema = z.object({ status: z.enum(['active', 'disabled']) }).strict();

export function cmsAccountRoutes(auth: CmsAuthService): FastifyPluginAsync {
  return async (app) => {
    app.get('/', async () => auth.listAccess());

    app.post('/invitations', async (request, reply) => {
      const input = emailBodySchema.parse(request.body);
      await auth.invite(input.email);
      return reply.code(202).send({ accepted: true });
    });

    app.post('/invitations/:id/resend', async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      z.undefined().parse(request.body);
      await auth.resendInvitation(id);
      return reply.code(202).send({ accepted: true });
    });

    app.delete('/invitations/:id', async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      auth.revokeInvitation(id);
      return reply.code(204).send();
    });

    app.patch('/:id', async (request) => {
      const { id } = idParamsSchema.parse(request.params);
      const { status } = statusBodySchema.parse(request.body);
      return { account: auth.setAccountStatus(id, status) };
    });
  };
}
