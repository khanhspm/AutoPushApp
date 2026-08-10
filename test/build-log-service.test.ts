import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BuildLogService } from '../src/services/build-log-service';

const temporaryDirectories: string[] = [];

async function createService() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'autopush-logs-'));
  temporaryDirectories.push(directory);
  return new BuildLogService(directory);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('BuildLogService', () => {
  it('redacts secrets and returns a bounded tail', async () => {
    const service = await createService();
    const writer = await service.createWriter('build-123', 1, ['super-secret-token']);

    await writer.write('starting\nsecret=super-secret-token\nfinished\n');
    await writer.close();

    const result = await service.readTail(writer.relativePath, 1024);
    expect(result.content).toContain('secret=[REDACTED]');
    expect(result.content).not.toContain('super-secret-token');
  });

  it('rejects path traversal', async () => {
    const service = await createService();
    await expect(service.readTail('../outside.log')).rejects.toThrow(/escapes|ENOENT/);
  });
});
