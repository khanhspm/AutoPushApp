export interface BuildCommand {
  projectId: string;
  appVersion: string | null;
  buildNumber: string;
  releaseNotes: string;
}

const PROJECT_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;
const APP_VERSION_PATTERN = /^\d+(?:\.\d+){0,2}$/;
const BUILD_NUMBER_PATTERN = /^[A-Za-z0-9_.-]+$/;

export function extractLarkTextContent(content: unknown): string {
  if (typeof content !== 'string') {
    return '';
  }

  try {
    const parsed = JSON.parse(content) as { text?: string };
    return parsed.text ?? content;
  } catch {
    return content;
  }
}

export function parseBuildCommand(input: string): BuildCommand | null {
  const text = input.replace(/<at[^>]*>.*?<\/at>/g, '').trim();
  const currentMatch = text.match(/^\/build\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+"([\s\S]*)"|\s+([\s\S]+))?$/);

  if (currentMatch) {
    const [, projectId, appVersion, buildNumber, quotedNotes, plainNotes] = currentMatch;
    if (
      PROJECT_ID_PATTERN.test(projectId)
      && APP_VERSION_PATTERN.test(appVersion)
      && BUILD_NUMBER_PATTERN.test(buildNumber)
    ) {
      return {
        projectId,
        appVersion,
        buildNumber,
        releaseNotes: (quotedNotes ?? plainNotes ?? '').trim(),
      };
    }
  }

  const legacyMatch = text.match(/^\/build\s+(\S+)\s+(\S+)(?:\s+"([\s\S]*)")?$/);
  if (!legacyMatch) {
    return null;
  }

  const [, projectId, buildNumber, quotedNotes] = legacyMatch;
  if (!PROJECT_ID_PATTERN.test(projectId) || !BUILD_NUMBER_PATTERN.test(buildNumber)) {
    return null;
  }

  return {
    projectId,
    appVersion: null,
    buildNumber,
    releaseNotes: (quotedNotes ?? '').trim(),
  };
}

export function isAllowedProject(projectId: string, allowedProjectIds: string[]): boolean {
  return allowedProjectIds.length === 0 || allowedProjectIds.includes(projectId);
}

export function buildCommandHelp(): string {
  return 'Cú pháp: /build <project_id> <app_version> <build_number> "<release_notes>". Ví dụ: /build MyApp 1.1 6 "Fix login bug"';
}
