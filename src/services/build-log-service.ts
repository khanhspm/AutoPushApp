import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

const MAX_TAIL_BYTES = 256 * 1024;
const SAFE_ID_PATTERN = /^[A-Za-z0-9-]+$/;

function redactText(value: string, secrets: string[]): string {
  return secrets.reduce((redacted, secret) => {
    if (!secret) {
      return redacted;
    }

    return redacted.split(secret).join('[REDACTED]');
  }, value);
}

export interface BuildLogWriter {
  relativePath: string;
  write(chunk: string | Buffer): Promise<void>;
  close(): Promise<void>;
}

export class BuildLogService {
  constructor(private readonly logRoot: string) {}

  async createWriter(buildId: string, attempt: number, secretValues: string[]): Promise<BuildLogWriter> {
    if (!SAFE_ID_PATTERN.test(buildId) || !Number.isInteger(attempt) || attempt < 1) {
      throw new Error('Invalid build log identifier');
    }

    await fsPromises.mkdir(this.logRoot, { recursive: true, mode: 0o700 });

    const relativePath = path.join(buildId, `attempt-${attempt}.log`);
    const absolutePath = this.resolveInsideRoot(relativePath);
    const directory = path.dirname(absolutePath);

    await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });

    const directoryStat = await fsPromises.lstat(directory);
    if (directoryStat.isSymbolicLink()) {
      throw new Error('Build log directory cannot be a symbolic link');
    }

    const handle = await fsPromises.open(absolutePath, 'wx', 0o600);
    const secrets = [...new Set(secretValues.filter(Boolean))].sort((left, right) => right.length - left.length);
    let pending = '';
    let closed = false;

    const flushCompleteLines = async (force: boolean): Promise<void> => {
      if (!pending) {
        return;
      }

      const lastNewline = pending.lastIndexOf('\n');
      const flushLength = force ? pending.length : lastNewline + 1;

      if (flushLength === 0) {
        return;
      }

      const output = redactText(pending.slice(0, flushLength), secrets);
      pending = pending.slice(flushLength);
      await handle.write(output);
    };

    return {
      relativePath,
      async write(chunk) {
        if (closed) {
          throw new Error('Build log writer is already closed');
        }

        pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
        await flushCompleteLines(false);
      },
      async close() {
        if (closed) {
          return;
        }

        closed = true;
        await flushCompleteLines(true);
        await handle.close();
      },
    };
  }

  async readTail(relativePath: string, requestedBytes = 64 * 1024): Promise<{ content: string; truncated: boolean }> {
    const tailBytes = Math.min(Math.max(Math.trunc(requestedBytes), 1), MAX_TAIL_BYTES);
    const absolutePath = await this.resolveExistingFile(relativePath);
    const stat = await fsPromises.stat(absolutePath);
    const start = Math.max(0, stat.size - tailBytes);
    const length = stat.size - start;
    const handle = await fsPromises.open(absolutePath, 'r');

    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      return { content: buffer.toString('utf8'), truncated: start > 0 };
    } finally {
      await handle.close();
    }
  }

  async createDownloadStream(relativePath: string): Promise<fs.ReadStream> {
    const absolutePath = await this.resolveExistingFile(relativePath);
    return fs.createReadStream(absolutePath);
  }

  private resolveInsideRoot(relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new Error('Build log path must be relative');
    }

    const root = path.resolve(this.logRoot);
    const resolved = path.resolve(root, relativePath);

    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error('Build log path escapes the configured log directory');
    }

    return resolved;
  }

  private async resolveExistingFile(relativePath: string): Promise<string> {
    const root = await fsPromises.realpath(path.resolve(this.logRoot));
    const candidate = this.resolveInsideRoot(relativePath);
    const candidateStat = await fsPromises.lstat(candidate);
    if (candidateStat.isSymbolicLink()) {
      throw new Error('Build log cannot be a symbolic link');
    }
    const realCandidate = await fsPromises.realpath(candidate);

    if (!realCandidate.startsWith(`${root}${path.sep}`)) {
      throw new Error('Build log path escapes the configured log directory');
    }

    const stat = await fsPromises.lstat(realCandidate);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Build log is not a regular file');
    }

    return realCandidate;
  }
}
