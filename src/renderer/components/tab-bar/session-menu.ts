import { appState, type ProjectRecord, type SessionRecord } from '../../state.js';
import type { ProviderId } from '../../../shared/types.js';
import { showModal, closeModal, setModalError, FieldDef } from '../modal.js';
import { findInvalidEnvLines } from '../../../shared/env-vars.js';
import { showJoinDialog } from '../join-dialog.js';
import { loadProviderAvailability, getProviderAvailabilitySnapshot } from '../../provider-availability.js';
import { hideTabContextMenu, setActiveContextMenu, positionMenu } from './menu.js';
import { t } from '../../i18n.js';
import { defaultSessionName, nextNumberFor, nextSessionNumber, MCP_INSPECTOR_NAME_KEY } from '../../state/session-naming.js';
import { attachPathAutocomplete } from '../path-autocomplete.js';
import { sshHostOptions } from '../../../shared/ssh-host.js';
import { resolveRunLocation } from '../../run-location.js';
import { basename } from '../../../shared/platform.js';
import { viewProject, type TabBarView } from './views.js';
import { viewOwnsLayout } from '../../session-window-state.js';
import { focusIfInSessionWindow } from '../../reveal.js';

/** The project with this id, or the active project when no id is given. */
function projectById(projectId?: string): ProjectRecord | undefined {
  return projectId ? appState.getProject(projectId) : appState.activeProject;
}

/**
 * New session with default settings in `projectId` (default: the active project).
 * `doc` is the document the action came from (default: the main window's): its
 * focused element is released so the new pane can take focus, and a dialog opens there.
 */
export function quickNewSession(projectId?: string, doc: Document = document): void {
  const project = projectById(projectId);
  if (!project) return;
  // The Temporary project has no folder of its own: every session needs one picked.
  if (project.temporary) { void promptNewSession(undefined, { projectId: project.id, doc }); return; }
  (doc.activeElement as HTMLElement | null)?.blur?.();
  focusIfInSessionWindow(project.id, appState.addSession(project.id, defaultSessionName(project)));
}

// "More" overflow menu. Deliberately excludes actions that have their own
// toolbar icon (Terminal, Browser) and the New/Custom Session actions
// (those live on the pill + its caret). Opens in `view`'s document and acts on
// its project; without a view, the main window and the active project.
export function showMoreMenu(x: number, y: number, view?: TabBarView): void {
  hideTabContextMenu();

  const doc = view?.doc ?? document;
  const project = view ? viewProject(view) : appState.activeProject;
  const menu = doc.createElement('div');
  menu.className = 'tab-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const addItem = (label: string, onClick: () => void): void => {
    const item = doc.createElement('div');
    item.className = 'tab-context-menu-item';
    item.textContent = label;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      onClick();
    });
    menu.appendChild(item);
  };

  const addSeparator = (): void => {
    const sep = doc.createElement('div');
    sep.className = 'tab-context-menu-separator';
    menu.appendChild(sep);
  };

  // Same rule as the Swarm shortcut: no layout toggle in the detached project's main view.
  if (!project || viewOwnsLayout(view?.kind ?? 'main', project.id)) {
    const swarmActive = project?.layout.mode === 'swarm';
    addItem(swarmActive ? t('tab.moreMenu.swarmLayoutActive') : t('tab.moreMenu.swarmLayout'), () => appState.toggleSwarm(project?.id));
  }
  addItem(t('tab.moreMenu.mcpInspector'), () => { if (project) addMcpInspector(project.id); });

  addSeparator();
  addItem(t('tab.moreMenu.joinRemoteSession'), () => showJoinDialog({ projectId: project?.id, doc }));

  doc.body.appendChild(menu);
  setActiveContextMenu(menu);

  positionMenu(menu);
}

/** "Run on" value for "this project" (an SSH alias never contains brackets). '' = this computer, else an SSH host. */
const RUN_ON_PROJECT = '[project]';

export interface PromptNewSessionOptions {
  /** Project the dialog offers as "This project". Default: the active project. */
  projectId?: string;
  /** Document to open the dialog in. Default: the main window's `document`. */
  doc?: Document;
}

export async function promptNewSession(
  onCreated?: (session: SessionRecord) => void,
  opts: PromptNewSessionOptions = {},
): Promise<void> {
  const doc = opts.doc ?? document;
  // "This project" is offered only for a real project; the Temporary project
  // (or no project at all) only takes sessions with their own folder.
  const active = projectById(opts.projectId);
  const project = active && !active.temporary ? active : undefined;

  const sessionNum = active ? nextSessionNumber(active) : 1;

  // Independent lookups: fetch the SSH hosts while provider availability loads.
  const sshHostsPending = window.vibeyard.remote.listHosts().catch(() => []);
  let providerSnapshot = getProviderAvailabilitySnapshot();
  if (!providerSnapshot) {
    await loadProviderAvailability();
    providerSnapshot = getProviderAvailabilitySnapshot();
  }
  const providers = providerSnapshot?.providers ?? [];
  const availabilityMap = providerSnapshot?.availability ?? new Map();
  const sshHosts = await sshHostsPending;

  // "Run on": RUN_ON_PROJECT = this project; '' (this computer) / an SSH
  // alias = a temporary session in a folder of that machine, outside every project.
  let runOn = project ? RUN_ON_PROJECT : '';
  const isProject = (value: string) => value === RUN_ON_PROJECT;
  const hostOf = (value: string) => (isProject(value) ? '' : value);
  let refreshPathSuggestions: () => void = () => {};
  // The dialog's fields live in the dialog's document, not necessarily the main one.
  const pathInput = () => doc.getElementById('modal-run-path') as HTMLInputElement | null;
  const defaultName = t('tab.newSessionModal.namePlaceholder', { num: sessionNum });

  const preferred = appState.preferences.defaultProvider ?? 'claude';
  const effectiveProvider = (availabilityMap.get(preferred) ? preferred : providers.find(p => availabilityMap.get(p.id))?.id) ?? 'claude';
  let selectedProvider: string = effectiveProvider;
  const claudeProfiles = appState.profiles.filter(p => p.providerId === 'claude');
  // Profiles only apply to Claude, and only locally: they relocate the *local*
  // CLAUDE_CONFIG_DIR, while a remote session uses the host's own login.
  const syncProfileField = () => {
    if (claudeProfiles.length > 0) setFieldVisible(doc, 'profile', selectedProvider === 'claude' && !hostOf(runOn));
  };
  // Folder only for a temporary session; "keep for future sessions" only for a project.
  const syncRunOnFields = () => {
    setFieldVisible(doc, 'run-path', !isProject(runOn));
    setFieldVisible(doc, 'keep-args', isProject(runOn));
    setFieldVisible(doc, 'keep-env', isProject(runOn));
    syncProfileField();
  };

  const fields: FieldDef[] = [
    { label: t('tab.newSessionModal.nameLabel'), id: 'session-name', placeholder: defaultName, defaultValue: defaultName },
    {
      label: t('tab.newSessionModal.runOnLabel'),
      id: 'run-on',
      type: 'select',
      defaultValue: runOn,
      onSelectChange: (value) => {
        runOn = value;
        syncRunOnFields();
        const input = pathInput();
        if (!input || isProject(value)) return;
        input.placeholder = hostOf(value) ? t('tab.newSessionModal.remotePathPlaceholder') : t('tab.newSessionModal.localPathPlaceholder');
        if (hostOf(value) && !input.value.trim()) input.value = '~/';
        input.focus();
        refreshPathSuggestions();
      },
      options: [
        ...(project ? [{ value: RUN_ON_PROJECT, label: project.remoteHost ? t('tab.newSessionModal.runOnProjectRemote', { host: project.remoteHost }) : t('tab.newSessionModal.runOnProjectLocal') }] : []),
        ...sshHostOptions(sshHosts, t('tab.newSessionModal.runOnLocalFolder')),
      ],
    },
    {
      label: t('tab.newSessionModal.folderLabel'),
      id: 'run-path',
      placeholder: t('tab.newSessionModal.localPathPlaceholder'),
      buttonLabel: t('sidebar.newProject.browseButton'),
      onButtonClick: async (input) => {
        if (hostOf(runOn)) {
          // No native dialog for a remote filesystem: start at ~/ and show its folders.
          if (!input.value.trim()) input.value = '~/';
          input.focus();
          refreshPathSuggestions();
          return;
        }
        const dir = await window.vibeyard.fs.browseDirectory();
        if (dir) input.value = dir;
      },
    },
    { label: t('tab.newSessionModal.argumentsLabel'), id: 'session-args', placeholder: t('tab.newSessionModal.argumentsPlaceholder'), defaultValue: project?.defaultArgs ?? '' },
    {
      label: t('tab.newSessionModal.keepArgsLabel'),
      id: 'keep-args',
      type: 'checkbox',
      defaultValue: project?.defaultArgs ? 'true' : undefined,
    },
    { label: t('tab.newSessionModal.envLabel'), id: 'session-env', type: 'textarea', placeholder: t('tab.newSessionModal.envPlaceholder'), defaultValue: project?.defaultEnv ?? '' },
    {
      label: t('tab.newSessionModal.keepEnvLabel'),
      id: 'keep-env',
      type: 'checkbox',
      defaultValue: project?.defaultEnv ? 'true' : undefined,
    },
  ];

  if (providers.length > 1) {
    fields.unshift({
      label: t('tab.newSessionModal.providerLabel'),
      id: 'provider',
      type: 'select',
      defaultValue: effectiveProvider,
      onSelectChange: (value) => {
        selectedProvider = value;
        syncProfileField();
      },
      options: providers.map(p => {
        const available = availabilityMap.get(p.id);
        return { value: p.id, label: available ? p.displayName : t('tab.newSessionModal.providerNotInstalled', { name: p.displayName }), disabled: !available };
      }),
    });
  }

  // Profile picker (Claude only). Defaults to the project/global default.
  if (claudeProfiles.length > 0) {
    fields.push({
      label: t('tab.newSessionModal.profileLabel'),
      id: 'profile',
      type: 'select',
      defaultValue: project?.defaultProfileId ?? appState.preferences.defaultProfileId ?? '',
      options: [
        { value: '', label: t('sidebar.defaultProfileOption') },
        ...claudeProfiles.map(p => ({ value: p.id, label: p.name })),
      ],
    });
  }

  showModal(t('tab.newSessionModal.title'), fields, async (values) => {
    let name = values['session-name']?.trim();
    if (!name) return;

    const envVars = values['session-env']?.trim() || undefined;
    if (envVars) {
      const invalid = findInvalidEnvLines(envVars);
      if (invalid.length > 0) {
        setModalError('session-env', t('tab.newSessionModal.envError', { line: invalid[0] }));
        return;
      }
    }

    const providerId = (values['provider'] || 'claude') as ProviderId;
    const runOnValue = values['run-on'] ?? '';
    const sshHost = hostOf(runOnValue);
    // Remote spawns support only Claude — whether the host is picked here or is the project's own.
    if ((sshHost || (isProject(runOnValue) && project?.remoteHost)) && providerId !== 'claude') {
      setModalError(values['provider'] !== undefined ? 'provider' : 'run-on', t('tab.newSessionModal.remoteClaudeOnly'));
      return;
    }
    const args = values['session-args']?.trim() || undefined;
    // Profiles only apply to Claude; ignore the field for other providers and remote hosts.
    const profileId = providerId === 'claude' && !sshHost ? (values['profile'] || undefined) : undefined;

    if (isProject(runOnValue) && project) {
      closeModal();
      project.defaultArgs = values['keep-args'] === 'true' ? (args || undefined) : undefined;
      project.defaultEnv = values['keep-env'] === 'true' ? (envVars || undefined) : undefined;
      const session = appState.addSession(project.id, name, args, providerId, profileId, envVars);
      focusIfInSessionWindow(project.id, session);
      if (session && onCreated) onCreated(session);
      return;
    }

    // Temporary session: resolve and verify the folder on the chosen machine.
    const res = await resolveRunLocation(sshHost, values['run-path']?.trim() || '~');
    if (!res.ok) {
      setModalError(res.field === 'host' ? 'run-on' : 'run-path', res.error);
      return;
    }
    const location = { path: res.path, ...(sshHost ? { host: sshHost } : {}) };
    // Untouched default name: label the tab with where it runs instead.
    if (name === defaultName) name = `${basename(location.path) || location.path}${sshHost ? ` @ ${sshHost}` : ''}`;

    closeModal();
    const session = appState.addTemporarySession(name, location, args, providerId, envVars, profileId);
    if (session && onCreated) onCreated(session);
  }, opts.doc ? { doc: opts.doc } : undefined);

  syncRunOnFields();
  // Folder: local or remote autocomplete, following the "Run on" choice.
  const input = pathInput();
  if (input) refreshPathSuggestions = attachPathAutocomplete(input, { getHost: () => hostOf(runOn) }).refresh;
}

/** Toggle a field's wrapper in the open modal (in `doc`) by field id. */
function setFieldVisible(doc: Document, id: string, visible: boolean): void {
  const wrapper = doc.getElementById(`modal-${id}`)?.closest('.modal-field') as HTMLElement | null;
  if (wrapper) wrapper.style.display = visible ? '' : 'none';
}

function addMcpInspector(projectId?: string): void {
  const project = projectById(projectId);
  if (!project) return;

  const inspectorNum = nextNumberFor(MCP_INSPECTOR_NAME_KEY, project);
  const session = appState.addMcpInspectorSession(project.id, t('tab.newMcpInspector.defaultName', { num: inspectorNum }));
  focusIfInSessionWindow(project.id, session);
}
