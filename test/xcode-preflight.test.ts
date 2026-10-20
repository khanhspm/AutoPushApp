import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { validateXcodeScheme } from '../src/services/xcode-preflight-service';

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'autopush-xcode-test-'));
  await fs.mkdir(path.join(directory, 'SPCleaner.xcodeproj'));
});
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

it('rejects the display name instead of silently using another scheme', async () => {
  const run = vi.fn().mockResolvedValue(JSON.stringify({ project: { schemes: ['SPCleaner'] } }));
  await expect(validateXcodeScheme(directory, 'Speaker', run)).rejects.toThrow('Available schemes: SPCleaner');
  await expect(validateXcodeScheme(directory, 'SPCleaner', run)).resolves.toBeUndefined();
  expect(run).toHaveBeenCalledWith(directory, ['-list', '-json', '-project', 'SPCleaner.xcodeproj']);
});

it('prefers the workspace and validates an overridden scheme against its list', async () => {
  await fs.mkdir(path.join(directory, 'SPCleaner.xcworkspace'));
  const run = vi.fn().mockResolvedValue(JSON.stringify({ workspace: { schemes: ['SPCleaner', 'SPCleanerDev'] } }));
  await validateXcodeScheme(directory, 'SPCleanerDev', run);
  expect(run).toHaveBeenCalledWith(directory, ['-list', '-json', '-workspace', 'SPCleaner.xcworkspace']);
});

it('keeps the app scheme visible when Xcode lists many dependency schemes', async () => {
  const run = vi.fn().mockResolvedValue(JSON.stringify({ project: { schemes: [
    ...Array.from({ length: 50 }, (_, index) => `Dependency${index}`), 'SPCleaner',
  ] } }));
  await expect(validateXcodeScheme(directory, 'Speaker', run)).rejects.toThrow('Available schemes: SPCleaner,');
});

it('does not fall back on missing schemes, invalid output or ambiguous containers', async () => {
  const run = vi.fn().mockResolvedValue('not JSON');
  await expect(validateXcodeScheme(directory, null, run)).rejects.toThrow('explicit shared Xcode scheme');
  expect(run).not.toHaveBeenCalled();
  await expect(validateXcodeScheme(directory, 'SPCleaner', run)).rejects.toThrow('invalid scheme list');
  await fs.mkdir(path.join(directory, 'Other.xcodeproj'));
  await expect(validateXcodeScheme(directory, 'SPCleaner', run)).rejects.toThrow('Expected one Xcode workspace');
});
