import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export type XcodeListRunner = (repoPath: string, args: string[]) => Promise<string>;

const listWithXcode: XcodeListRunner = async (repoPath, args) => {
  try {
    const { stdout } = await execute('xcodebuild', args, {
      cwd: repoPath,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch {
    throw new Error('Unable to list Xcode schemes within 120 seconds. Check Xcode and package dependencies in the repository.');
  }
};

export async function validateXcodeScheme(
  repoPath: string,
  scheme: string | null | undefined,
  run: XcodeListRunner = listWithXcode,
): Promise<void> {
  if (!scheme?.trim()) throw new Error('Select an explicit shared Xcode scheme before building.');
  const entries = await fs.readdir(repoPath, { withFileTypes: true });
  const containers = (suffix: string) => entries.filter((entry) => entry.isDirectory() && entry.name.endsWith(suffix));
  const workspaces = containers('.xcworkspace');
  const candidates = workspaces.length ? workspaces : containers('.xcodeproj');
  if (candidates.length !== 1) {
    throw new Error('Expected one Xcode workspace or project at the repository root; cannot safely select a build container.');
  }
  const output = await run(repoPath, ['-list', '-json', workspaces.length ? '-workspace' : '-project', candidates[0].name]);
  let schemes: string[];
  try {
    const result = JSON.parse(output);
    const value = (result.workspace ?? result.project)?.schemes;
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error();
    schemes = value;
  } catch {
    throw new Error('Xcode returned an invalid scheme list; cannot safely start the build.');
  }
  if (!schemes.includes(scheme)) {
    // Workspaces can include dozens of Pod schemes. Keep the app suggestion visible
    // within the build record's error-message limit.
    const appName = candidates[0].name.replace(/\.(xcworkspace|xcodeproj)$/, '');
    const suggestions = [...schemes.filter((name) => name === appName), ...schemes.filter((name) => name !== appName)].slice(0, 8);
    const remaining = schemes.length - suggestions.length;
    throw new Error(`Xcode scheme "${scheme}" was not found. Available schemes: ${suggestions.join(', ') || '(none)'}${remaining ? ` (and ${remaining} more)` : ''}. Share the scheme in Xcode and select its exact name in the CMS.`);
  }
}
