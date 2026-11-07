/**
 * The project's folder on *this* machine, or undefined when it has none: a
 * remote (SSH) project's `path` is on its host, and the built-in Temporary
 * project has no folder at all (each of its sessions carries its own). Every
 * project-folder feature (git, file listing, shell cwd, the fs sandbox) asks
 * this instead of checking `remoteHost` / `temporary` itself.
 */
export function localProjectFolder(project: ProjectFolderSource): string | undefined {
  const loc = projectFolderLocation(project);
  return loc && !loc.host ? loc.path : undefined;
}

type ProjectFolderSource = { path: string; remoteHost?: string; temporary?: boolean };

/** Where a project's folder lives: `host` is set for a remote (SSH) project, whose `path` is on that host. */
export interface ProjectFolderLocation {
  path: string;
  host?: string;
}

/**
 * The project's folder wherever it lives, or undefined when it has none (the
 * Temporary project). Features that can work over SSH (the sidebar file tree)
 * ask this; local-only ones ask `localProjectFolder`.
 */
export function projectFolderLocation(project: ProjectFolderSource): ProjectFolderLocation | undefined {
  if (project.temporary || !project.path) return undefined;
  return project.remoteHost ? { path: project.path, host: project.remoteHost } : { path: project.path };
}
