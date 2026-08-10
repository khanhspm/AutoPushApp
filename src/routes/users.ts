import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import type { AppContext } from '../app-context';
import { AppError } from '../http/errors';

const userIdSchema = z.string().trim().min(1).max(200);
const userBodySchema = z.object({
  id: userIdSchema,
  displayName: z.string().trim().min(1).max(120),
  enabled: z.boolean().optional().default(true),
});
const userUpdateSchema = userBodySchema.omit({ id: true });
const permissionsSchema = z.object({
  projectKeys: z.array(z.string().trim().min(1).max(80)).max(500),
});

export function userRoutes(context: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.get('/', async () => ({ users: context.users.list() }));

    app.post('/', async (request, reply) => {
      const input = userBodySchema.parse(request.body);
      const user = context.users.create(input);
      return reply.code(201).send({ user });
    });

    app.get('/:userId', async (request) => {
      const userId = userIdSchema.parse((request.params as { userId: string }).userId);
      const user = context.users.findById(userId);
      if (!user) {
        throw new AppError(404, 'USER_NOT_FOUND', 'User was not found');
      }
      return { user };
    });

    app.put('/:userId', async (request) => {
      const userId = userIdSchema.parse((request.params as { userId: string }).userId);
      const input = userUpdateSchema.parse(request.body);
      const user = context.users.update(userId, input);
      if (!user) {
        throw new AppError(404, 'USER_NOT_FOUND', 'User was not found');
      }
      return { user };
    });

    app.delete('/:userId', async (request, reply) => {
      const userId = userIdSchema.parse((request.params as { userId: string }).userId);
      if (!context.users.delete(userId)) {
        throw new AppError(404, 'USER_NOT_FOUND', 'User was not found');
      }
      return reply.code(204).send();
    });

    app.put('/:userId/project-permissions', async (request) => {
      const userId = userIdSchema.parse((request.params as { userId: string }).userId);
      const input = permissionsSchema.parse(request.body);
      const user = context.users.replaceProjectPermissions(userId, input.projectKeys);
      if (!user) {
        throw new AppError(404, 'USER_NOT_FOUND', 'User was not found');
      }
      return { user };
    });
  };
}
