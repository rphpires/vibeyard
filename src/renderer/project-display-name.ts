import type { ProjectRecord } from '../shared/types.js';
import { t } from './i18n.js';

/** The name a project is shown under: the Temporary project's is translated, never its stored one. */
export function projectDisplayName(project: Pick<ProjectRecord, 'name' | 'temporary'>): string {
  return project.temporary ? t('sidebar.temporaryProject') : project.name;
}
