# Janela de sessões destacada — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** botão no card do projeto que abre as sessões desse projeto numa segunda janela (outro monitor), com gerenciamento completo de abas, sem persistir o destaque.

**Architecture:** a janela de sessões é um documento `about:blank` aberto pelo renderer principal via `window.open`; todo o código continua no renderer principal (um `AppState`, um persist). `split-layout` e `tab-bar` deixam de ser singletons e viram *views* instanciáveis (container + documento + projeto + filtro de abas); a view principal e a view destacada mostram conjuntos disjuntos de abas. O processo principal só autoriza/controla a janela nova e roteia menu/zoom/diálogos.

**Tech Stack:** Electron 41, TypeScript, xterm.js 6 (`@xterm/addon-webgl`, `@xterm/addon-serialize`), Vitest, esbuild.

**Spec:** `docs/superpowers/specs/2026-11-07-session-window-design.md` — ler antes de qualquer tarefa; os itens "comportamento 1–9, 3b" são citados abaixo por número.

## Global Constraints

- Ler `CLAUDE.md` inteiro antes de começar; vale em especial o bullet "Renders must not touch pane DOM they don't need to" (`attach*ToContainer` no-op quando `parentElement === container`, `ensurePaneOrder`, `shouldFocusPane`, memo de `fitTerminal`).
- Trabalho de UI segue a skill `/ui-dev` (nada de `<select>` nativo, sem cores hardcoded, reusar componentes).
- Plataforma só via `src/main/platform.ts` (`isWin`/`isMac`/`isLinux`); nunca `process.platform` inline.
- Paths em testes com `path.join` (CI roda Windows).
- Só o renderer principal chama `store:save`; o documento da janela de sessões nunca tem preload nem código próprio.
- Destaque **não** é persistido; só `PersistedState.sessionWindowBounds` é.
- Strings novas em `src/renderer/locales/en.json` **e** `zh-CN.json`.
- **Commits:** este repo proíbe commit sem pedido do usuário. Onde o plano diz "Checkpoint", rode `npm test` e `npm run build`; commitar só se o usuário pedir, e então via `/commit`. Nunca `git push origin` (só `fork`).
- Ao final: `/code-review`, `/simplify` automaticamente; atualizar `CLAUDE.md` (Task 11).

## Review Focus

1. **Fechar/sair com a janela de sessões aberta:** quit pela principal fecha a de sessões junto, o diálogo de confirmação aparece uma vez só, e fechar só a de sessões nunca dispara confirmação nem mata PTY. → testes na Task 2 e Task 8.
2. **Sessão criada "por fora" no projeto destacado** (`vibeyard-ctl new-session`, board card Run, resume do histórico): o pane nasce na janela de sessões, com tamanho certo (fit depois do spawn), e a principal não troca de projeto. → teste na Task 9.
3. **Atalhos no lugar certo:** Ctrl+T / Ctrl+W / Ctrl+Tab com foco na janela de sessões agem no projeto destacado, não no ativo da principal; e vice-versa. → teste na Task 9.
4. **Projeto destacado some:** removido, "Close All Sessions", último CLI sai → janela fecha (remoção) ou mostra estado vazio com botão de nova sessão (sem sessões). → teste na Task 8.
5. **Monitores com DPI diferente / janela redimensionada:** `resize` do documento da janela de sessões refaz o fit dos panes dela; mover entre monitores não deixa o terminal borrado ou com cols erradas. → listener + teste na Task 8, verificação manual na Task 11.

---

### Task 1: Spike — mover xterm vivo entre documentos (descartável)

Sem testes, sem checkpoint, em branch/worktree descartável. Decide **move direto** vs **plano B (recriar + serialize)** para a Task 8.

**Files:** qualquer (o código não é mantido).

- [ ] **Step 1:** No `main.ts`, permitir temporariamente `window.open('about:blank','vibeyard-sessions')` em `setWindowOpenHandler` (`{ action: 'allow' }`).
- [ ] **Step 2:** No devtools do renderer principal: `const w = window.open('about:blank','vibeyard-sessions')`; adicionar no `w.document.head` `<link rel="stylesheet">` para `new URL('styles.css', document.baseURI).href` e `xterm.css`; copiar `document.documentElement.dataset.theme`; `w.document.body.appendChild(getTerminalInstance(id).element)` (expor no `window` para o spike).
- [ ] **Step 3:** Verificar e anotar: digitação, seleção com mouse, copy-on-select, colar, Cmd/Ctrl+F (find bar), cmd+click em link, `fitAddon.fit()` após resize da janela nova, WebGL (glifos ok ou contexto perdido?), mover a janela para monitor com escala diferente (nitidez), mover de volta para `#terminal-container`. Testar também descarregar o WebglAddon antes do move e `loadWebglWithFallback` depois.
- [ ] **Step 4:** Se algo falhar sem conserto simples: testar plano B — `SerializeAddon.serialize()` → `destroyTerminal` sem matar PTY → novo `Terminal` aberto no documento destino → `write(serialized)`.
- [ ] **Step 5:** Escrever o resultado como seção "Spike result" no fim deste arquivo: método escolhido (`move` | `recreate`), se WebGL precisa ser recarregado, problemas vistos. Descartar o código do spike.

---

### Task 2: Processo principal — janela principal explícita e menu roteado

**Files:**
- Create: `src/main/windows.ts`, `src/main/windows.test.ts`
- Modify: `src/main/main.ts`, `src/main/ipc-handlers.ts` (12 usos de `getAllWindows()[0]`), `src/main/auto-updater.ts:8`, `src/main/menu.ts:112-121`, `src/preload/preload.ts` (`menu` namespace), `src/renderer/keybindings.ts:31-39`, `src/renderer/types.ts` (tipos do `window.vibeyard`, se declarados lá)

**Interfaces:**
- Produces:
  - `getMainWindow(): BrowserWindow | null`, `setMainWindow(win: BrowserWindow | null): void`
  - `getSessionWindow(): BrowserWindow | null`, `setSessionWindow(win: BrowserWindow | null): void`
  - `windowKindOf(win: BrowserWindow | null): 'main' | 'sessions' | null`
  - Todo `menu:*` passa a ser enviado **sempre para a principal** com um último argumento `source: 'main' | 'sessions'` (a janela focada no clique). Preload: callbacks recebem `source` como último parâmetro.

- [ ] **Step 1: Testes** em `windows.test.ts`: `setMainWindow(a); getMainWindow() === a`; `windowKindOf(a) === 'main'`, `windowKindOf(b) === 'sessions'` após `setSessionWindow(b)`, `windowKindOf(c) === null`; destruída (`isDestroyed() → true`) faz `getMainWindow()` retornar `null`.
- [ ] **Step 2:** Rodar `npx vitest run src/main/windows.test.ts` → FAIL (módulo não existe).
- [ ] **Step 3:** Implementar `windows.ts`. Em `main.ts`, `setMainWindow` na criação e `null` em `closed`. Trocar **todos** os `BrowserWindow.getAllWindows()[0]` em `src/main/**` (exceto testes) por `getMainWindow()`. Em `menu.ts`, `sendToRenderer` usa `getMainWindow()` e anexa `windowKindOf(BrowserWindow.getFocusedWindow()) ?? 'main'`. Itens `Close Window` e `Reload Main Window`: se a focada for a de sessões, `close` fecha só ela e `reload` é ignorado.
- [ ] **Step 4:** `npx vitest run src/main` → PASS. `grep -rn "getAllWindows()\[0\]" src/main --include=*.ts | grep -v test` → vazio (o `app.on('activate')` que testa `getAllWindows().length === 0` continua).
- [ ] **Step 5: Checkpoint.**

---

### Task 3: Processo principal — abrir/controlar a janela de sessões

**Files:**
- Create: `src/main/session-window.ts`, `src/main/session-window.test.ts`
- Modify: `src/main/main.ts:58-61` (`setWindowOpenHandler`), `src/main/main.ts` (close confirmado da principal), `src/main/ipc-handlers.ts` (handlers novos + zoom + diálogos nativos), `src/shared/types.ts` (`PersistedState.sessionWindowBounds?: { x: number; y: number; width: number; height: number }`), `src/preload/preload.ts` (namespace `sessionWindow`)

**Interfaces:**
- Consumes: `getMainWindow`, `setSessionWindow`, `getSessionWindow` (Task 2).
- Produces:
  - `SESSION_WINDOW_FRAME = 'vibeyard-sessions'` (em `src/shared/session-window.ts`, importado pelos dois processos)
  - `isSessionWindowOpen(url: string, frameName: string): boolean` — `true` só para `url === 'about:blank' && frameName === SESSION_WINDOW_FRAME`
  - `resolveSessionWindowBounds(saved: Bounds | undefined, displays: { workArea: Bounds }[], main: Bounds): Bounds` — devolve `saved` se ≥ 50% da área dele cai dentro de algum `workArea`; senão 1000×700 centralizado em `main`.
  - IPC: `sessionWindow:focus` (show+focus+moveTop), `sessionWindow:close`, `sessionWindow:setTitle(title: string)`; evento `sessionWindow:closed` enviado à principal.
  - Preload `window.vibeyard.sessionWindow = { focus(), close(), setTitle(t), onClosed(cb) }`.

- [ ] **Step 1: Testes** em `session-window.test.ts`: `isSessionWindowOpen('about:blank', 'vibeyard-sessions') === true`; `('about:blank','x')`, `('https://a','vibeyard-sessions')`, `('file:///x','vibeyard-sessions')` → `false`. `resolveSessionWindowBounds`: saved dentro de display → igual a saved; saved num display que sumiu → `{ width: 1000, height: 700 }` centralizado em `main`; `undefined` → centralizado.
- [ ] **Step 2:** Rodar `npx vitest run src/main/session-window.test.ts` → FAIL.
- [ ] **Step 3:** Implementar. `setWindowOpenHandler`: se `isSessionWindowOpen(url, frameName)` e não há janela de sessões viva → `{ action: 'allow', overrideBrowserWindowOptions: { ...resolveSessionWindowBounds(state.sessionWindowBounds, screen.getAllDisplays(), main.getBounds()), minWidth: 500, minHeight: 300, title: 'Vibeyard', icon, backgroundColor: '#000000', autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, webviewTag: true } } }`; caso contrário o comportamento atual. `did-create-window`: `setSessionWindow`, guard `will-navigate` que só permite `about:blank`, `move`/`resize` com debounce 500 ms gravam `sessionWindowBounds` via `loadState`/`saveState`, `closed` → `setSessionWindow(null)` + `send('sessionWindow:closed')` à principal. No `close` **confirmado** da principal, fechar a de sessões antes. A de sessões não entra em `requestConfirmClose`. Zoom (`zoom:set`): aplicar também em `getSessionWindow()?.webContents`. Diálogos nativos abertos por IPC (`dialog.show*`): usar `BrowserWindow.getFocusedWindow() ?? getMainWindow()` como pai.
- [ ] **Step 4:** `npx vitest run src/main` → PASS; `npm run build` ok.
- [ ] **Step 5: Checkpoint.**

---

### Task 4: Renderer — estado de destaque e filtros DOM-free

**Files:**
- Create: `src/renderer/session-window-state.ts`, `src/renderer/session-window-state.test.ts`

**Interfaces:**
- Produces:
  - `type ViewKind = 'main' | 'sessions'`
  - `PROJECT_LEVEL_TAB_TYPES: readonly ['project-tab', 'kanban', 'team']`
  - `getDetachedProjectId(): string | null`, `setDetachedProjectId(id: string | null): void`, `onDetachedChange(cb: (id: string | null) => void): () => void` (observer no padrão de `session-unread.ts`; não persiste; `_resetForTesting()`)
  - `viewShowsSession(kind: ViewKind, projectId: string, session: SessionRecord): boolean` — se `projectId !== getDetachedProjectId()`: `kind === 'main'`. Se destacado: `'main'` ⇔ `session.type` ∈ `PROJECT_LEVEL_TAB_TYPES`; `'sessions'` ⇔ o contrário.
  - `viewTabs(kind: ViewKind, project: ProjectRecord): SessionRecord[]` = `tabSessions(project).filter(s => viewShowsSession(kind, project.id, s))`
  - `projectIdForView(kind: ViewKind, activeProjectId: string | null): string | null` — `'sessions'` → `getDetachedProjectId()`; `'main'` → `activeProjectId`.

- [ ] **Step 1: Testes**: sem destaque, `viewShowsSession('main', p, cli) === true` e `('sessions', …) === false`; com `p` destacado: CLI/file-reader/browser-tab → só `sessions`; project-tab/kanban/team → só `main`; outro projeto não afetado. `viewTabs` exclui detached (via `tabSessions`) e respeita o filtro. `onDetachedChange` dispara uma vez por mudança, não dispara em set igual.
- [ ] **Step 2:** `npx vitest run src/renderer/session-window-state.test.ts` → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5: Checkpoint.**

---

### Task 5: Refatorar `split-layout` em views (sem mudança de comportamento)

**Files:**
- Modify: `src/renderer/components/split-layout.ts`, `src/renderer/state/layout-state.ts` (`cycleSessionId`, `sessionIdAtIndex`, `toggleSwarmMode` aceitam `tabs?: SessionRecord[]`, default `tabSessions(project)`), `src/renderer/components/terminal-pane.ts` (`setFocused`, `fitAllVisible` por documento), e cada módulo de pane com `hideAll*Panes` (`mcp-inspector`, `file-viewer`, `file-reader`, `remote-terminal-pane`, `browser-tab-pane`, `project-tab/pane`, `kanban/pane`, `team/pane`)
- Test: `src/renderer/components/split-layout.test.ts` (+ testes existentes de `pane-focus`, `pane-order`, `layout-state`)

**Interfaces:**
- Consumes: `ViewKind`, `viewTabs`, `projectIdForView` (Task 4).
- Produces:
  - `interface LayoutView { kind: ViewKind; container: HTMLElement; doc: Document; }`
  - `createLayoutView(kind: ViewKind, container: HTMLElement): LayoutView` (registra a view num `Set` interno; `doc = container.ownerDocument`)
  - `destroyLayoutView(view: LayoutView): void`
  - `renderLayout(): void` passa a renderizar **todas** as views registradas; `renderView(view: LayoutView): void` faz o trabalho de hoje para o projeto `projectIdForView(view.kind, appState.activeProjectId)` usando `viewTabs(view.kind, project)` no lugar de `project.sessions`/`tabSessions`.
  - `hideAll*Panes()` → `hideAll*Panes(within?: HTMLElement)`: sem argumento = comportamento atual; com argumento esconde só elementos cujo `within.contains(el)`.
  - `fitAllVisible(doc?: Document)`; `setFocused(sessionId)` lê `activeElement` do `ownerDocument` do pane.
  - `onSessionAdded`: `isActive` vira "`project.id` é o projeto de alguma view registrada", e o `relayout`/fit acontece na(s) view(s) que mostram a sessão.
  - O estado vazio (`showEmptyState`), swarm wrapper e `lastFocusedPane` passam a ser por view.
- A view principal é criada em `initSplitLayout()` sobre `#terminal-container` com `kind: 'main'`. Sem destaque, o resultado é idêntico ao de hoje.

- [ ] **Step 1: Teste novo** em `split-layout.test.ts`: duas views em dois containers (jsdom), projeto A ativo na principal e B destacado (`setDetachedProjectId('B')`); `renderLayout()` → panes de B dentro do container `sessions`, panes de A no `main`; um segundo `renderLayout()` não esconde os panes da outra view nem chama `appendChild` em pane já posicionado (espionar `appendChild` como os testes existentes fazem). Testes de `layout-state`: `cycleSessionId(project, 1, tabs)` cicla só dentro de `tabs`.
- [ ] **Step 2:** `npx vitest run src/renderer/components/split-layout.test.ts src/renderer/state` → FAIL nos novos.
- [ ] **Step 3:** Implementar a refatoração.
- [ ] **Step 4:** `npm test` → tudo PASS (os testes existentes provam "sem mudança de comportamento").
- [ ] **Step 5: Checkpoint.**

---

### Task 6: Refatorar `tab-bar` em views

> **Ordem:** executar **depois da Task 7** (usa `showModal(..., { doc })`). Tasks 5 e 7 são independentes entre si.

**Files:**
- Modify: `src/renderer/components/tab-bar/index.ts`, `tab-list.ts`, `session-menu.ts`, `menu.ts`, `tab-scroll.ts`, `dom.ts`, `git-status-bar.ts`; `src/renderer/components/tab-bar.ts` (shim re-export)
- Test: `src/renderer/components/tab-bar/tab-list.test.ts` (criar se não existir), `tab-scroll.test.ts`

**Interfaces:**
- Consumes: `ViewKind`, `viewTabs`, `projectIdForView` (Task 4); `showModal(..., { doc })` (Task 7).
- Produces:
  - `interface TabBarView { kind: ViewKind; root: HTMLElement; tabListEl: HTMLElement; doc: Document; }`
  - `buildTabBarDom(doc: Document): HTMLElement` — cria a mesma estrutura de `#tab-bar` do `index.html` (lista, `#git-status` só para `main`, botões nova sessão/caret/browser/more). Para `main`, usar os nós existentes do `index.html` (não reconstruir).
  - `createTabBarView(kind: ViewKind, root: HTMLElement): TabBarView`, `destroyTabBarView(view)`
  - `render()` renderiza todas as views; `renderTabList(view)` usa `viewTabs(view.kind, project)`.
  - `quickNewSession(projectId?: string): void` e `promptNewSession(projectId?: string, doc?: Document): Promise<void>` — default = projeto ativo/documento principal (callers atuais intactos).
  - `showMoreMenu(x, y, view)`, `showTabContextMenu(..., view)`: menu criado em `view.doc.body`; listeners de fechar (`click`/`Escape`) registrados também em `view.doc`.
  - `tab-scroll` guarda estado por `(view.kind, projectId)`.
  - Git status bar e botão "terminal do projeto" só na view `main`.

- [ ] **Step 1: Testes**: com B destacado, `renderTabList(sessionsView)` gera abas só das sessões CLI/file/browser de B; `renderTabList(mainView)` com B ativo gera só Overview/Kanban/Team de B; `quickNewSession('B')` chama `appState.addSession('B', …)` mesmo com A ativo.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Checkpoint.**

---

### Task 7: UI em outro documento — modais, menus, selects, hover cards, estilos

**Files:**
- Create: `src/renderer/doc-chrome.ts`, `src/renderer/doc-chrome.test.ts`
- Modify: `src/renderer/components/modal.ts` (nós `#modal-*` resolvidos por documento), `custom-select.ts`, `hover-card.ts`, `terminal-context-menu.ts`, `search-bar.ts`, `modal-manager.ts`, `src/renderer/index.ts:237-250` (tema)

**Interfaces:**
- Produces:
  - `installDocChrome(target: Document, source: Document): () => void` — copia `<link rel="stylesheet">` do `source` com `href` absoluto (`new URL(href, source.baseURI).href`), copia `<meta http-equiv="Content-Security-Policy">`, espelha `documentElement.dataset.theme` (e o observa via `MutationObserver` no `source`), injeta o markup de `#modal-overlay` idêntico ao do `index.html`. Retorna cleanup.
  - `modalDoc` corrente: `showModal(..., opts?: { doc?: Document })`, `showConfirmDialog(..., { doc })`, `showConfirmModal(..., { doc })` — default `document`. O modal ativo lembra seu documento; `closeModal()` fecha o modal onde estiver.
  - `createCustomSelect`/`attachHoverCard`/menus usam `el.ownerDocument` do alvo/âncora em vez de `document` global.

- [ ] **Step 1: Testes** (`doc-chrome.test.ts`, jsdom com dois documentos via `document.implementation.createHTMLDocument`): links copiados com href absoluto; trocar `data-theme` no source reflete no target; `#modal-overlay` existe no target; cleanup remove observer. Teste em `modal` existente/novo: `showModal(..., { doc: other })` monta em `other`, não em `document`.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Checkpoint.**

---

### Task 8: Controlador da janela de sessões

**Files:**
- Create: `src/renderer/session-window.ts`, `src/renderer/session-window.test.ts`, `src/renderer/styles/session-window.css` (importado em `styles.css`)
- Modify: `src/renderer/components/terminal-pane.ts` (guardar o WebglAddon na instância; `reloadWebgl(sessionId)`; ou, se o spike escolheu `recreate`, `rehomeTerminal(sessionId, container)` com serialize), `src/renderer/index.ts` (init)

**Interfaces:**
- Consumes: Tasks 3 (`window.vibeyard.sessionWindow.*`), 4, 5 (`createLayoutView`, `fitAllVisible(doc)`), 6 (`buildTabBarDom`, `createTabBarView`), 7 (`installDocChrome`).
- Produces:
  - `openSessionWindow(projectId: string): void` — se já houver janela: só troca o projeto (`setDetachedProjectId(projectId)`; o anterior volta à principal por causa do filtro) e foca. Senão: `window.open('about:blank', SESSION_WINDOW_FRAME)`; `installDocChrome`; monta `<div class="session-window">` com tab bar (Task 6), container de panes e botão **"Voltar para a janela principal"** (`t('sessionWindow.returnToMain')`); cria as views `sessions`; registra `keydown` → `shortcutManager.matchEvent` no documento novo; `resize` do documento novo → `requestAnimationFrame(() => fitAllVisible(doc))`; `setDetachedProjectId(projectId)`; `renderLayout()` + tab bar render; título via `sessionWindow.setTitle(\`${project.name} — Vibeyard\`)`.
  - `closeSessionWindow(): void` — idempotente; chama `sessionWindow.close()`.
  - Ao receber `sessionWindow.onClosed` (ou `unload` do documento): destruir views, `setDetachedProjectId(null)`, devolver os elementos dos panes ao `#terminal-container` **escondidos** (`hidden`), recarregar WebGL, `renderLayout()`. Nenhum PTY é tocado.
  - `focusSessionWindow(): void` → `sessionWindow.focus()`.
  - `isSessionWindowFocused(): boolean` → `doc?.hasFocus() ?? false`.
  - Ganchos: `project-removed` do destacado → `closeSessionWindow()`; rename do projeto → atualiza título; `beforeunload` da principal → `closeSessionWindow()`.
  - Panes movidos para o documento novo: depois do move, `reloadWebgl` em cada terminal e `fitTerminal` (o memo `lastSize` impede resize redundante).

- [ ] **Step 1: Testes** (mock de `window.open` devolvendo um `Window` de jsdom, mock de `window.vibeyard.sessionWindow`): `openSessionWindow('B')` → `getDetachedProjectId() === 'B'` e `setTitle('B — Vibeyard')`; segunda chamada com `'C'` não chama `window.open` de novo e troca para `'C'`; `onClosed` → `getDetachedProjectId() === null`, panes de B de volta em `#terminal-container` com classe `hidden`, **nenhuma** chamada a `pty.kill`; `project-removed('B')` → `sessionWindow.close` chamado; evento `resize` no documento novo → `fitAllVisible` chamado com esse documento; B sem sessões → container mostra o estado vazio com botão de nova sessão.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Checkpoint.**

---

### Task 9: Roteamento — projeto ativo, atalhos, menu, Active Sessions, ctl

**Files:**
- Create: `src/renderer/reveal.ts`, `src/renderer/reveal.test.ts`
- Modify: `src/renderer/state.ts` (`toggleSwarm`, `cycleSession`, `gotoSession` aceitam `projectId?`; `openProjectTab`/`openKanbanTab`/`openTeamTab`/`addSession`/`activateExistingSession`), `src/renderer/keybindings.ts`, `src/renderer/components/active-sessions-panel.ts:163`, `src/renderer/ctl-handler.ts`, `src/renderer/components/split-layout.ts` (aviso da view principal), `src/renderer/components/board/board-card.ts`, `src/renderer/components/session-history.ts` (resume)

**Interfaces:**
- Consumes: Tasks 4, 8.
- Produces:
  - `commandTargetProjectId(source?: 'main' | 'sessions'): string | null` — `source === 'sessions'` ou (`source` ausente e `isSessionWindowFocused()`) → `getDetachedProjectId()`; senão `appState.activeProjectId`.
  - `commandTargetSession(source?): SessionRecord | undefined` — a sessão ativa do projeto alvo **dentro da view** (`viewTabs`); para a view principal com projeto destacado, a aba de projeto selecionada nela.
  - `revealSession(projectId: string, sessionId: string): void` — se a sessão é mostrada pela view `sessions`: `appState.setActiveSession` + `focusSessionWindow()`; senão o caminho atual (`setActiveProject` se preciso + `setActiveSession`).
  - `revealProject(projectId: string): void` — `setActiveProject(projectId)` e, se destacado, também `focusSessionWindow()` (comportamento 3).
  - Aviso da view principal (projeto ativo destacado e nenhuma aba de projeto selecionada): `t('sessionWindow.placeholder')` + botões `t('sessionWindow.show')` → `focusSessionWindow()` e `t('sessionWindow.bringBack')` → `closeSessionWindow()`.
- Regras:
  - Handlers de `keybindings.ts` que hoje usam `appState.activeProject/activeSession` (nova sessão, fechar aba, ciclar/goto, toggle split, find, goto-line, browser reload, inspector) passam a usar `commandTargetProjectId()`/`commandTargetSession()`. Os de `menu.*` recebem `source` (Task 2). Atalhos só da principal (sidebar, git panel, terminal do projeto, quick open, session search, new project, help/preferences) disparados da janela de sessões: `window.focus()` da principal e executam lá.
  - Criar sessão no projeto destacado (`addSession`, ctl `new-session --focus`) **não** chama `setActiveProject`. Os `if (activeProjectId !== projectId) setActiveProject(projectId)` de `openProjectTab`/`openKanbanTab`/`openTeamTab` continuam (essas abas moram na principal).
  - Active Sessions (`active-sessions-panel.ts`), board cards e resume usam `revealSession`; clique no card da sidebar usa `revealProject` (Task 10).
  - `onSessionAdded` para sessão do destacado faz o fit depois do spawn na view `sessions` (já coberto pela Task 5; confirmar aqui com teste).

- [ ] **Step 1: Testes** (`reveal.test.ts` + casos em `state.test.ts`): com A ativo e B destacado e janela de sessões focada (mock `isSessionWindowFocused → true`): `commandTargetProjectId() === 'B'`; com `source: 'main'` → `'A'`; `quickNewSession(commandTargetProjectId())` cria em B e `activeProjectId` continua `'A'`; ctl `new-session --project B --focus` não muda `activeProjectId` e chama `focusSessionWindow`; `revealSession('B', s)` chama `focusSessionWindow` e não `setActiveProject`; `revealProject('B')` chama ambos; `cycleSession(1, 'B')` só cicla abas da view `sessions`.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Checkpoint.**

---

### Task 10: Botão na sidebar, indicador, preferência, i18n

**Files:**
- Modify: `src/renderer/components/sidebar.ts` (`buildProjectActions` ~L342, clique no card, render no `onDetachedChange`), `src/renderer/icons.ts` (ícone novo, estilo dos existentes), `src/shared/types.ts:409` (`sidebarViews.sessionWindow: boolean`), `src/renderer/state.ts:125` (default `sessionWindow: true`), `src/renderer/components/preferences/appearance-section.ts:68-124`, `src/renderer/styles/sidebar.css`, `src/renderer/locales/en.json`, `src/renderer/locales/zh-CN.json`
- Test: `src/renderer/components/sidebar.test.ts`

**Interfaces:**
- Consumes: `openSessionWindow`, `closeSessionWindow` (Task 8), `revealProject` (Task 9), `getDetachedProjectId`/`onDetachedChange` (Task 4).
- Produces:
  - Botão em `buildProjectActions` com `makeActionButton(t('sidebar.detachSessions'), ICON_DETACH, isDetached)`; clique: destacado → `closeSessionWindow()`, senão → `openSessionWindow(project.id)`. Só se `appState.preferences.sidebarViews?.sessionWindow ?? true` (Temporary já não tem a fileira).
  - `.project-row.detached-window` no card do destacado (ativo ou não).
  - Clique no card do destacado → `revealProject(project.id)`.
  - Toggle `{ key: 'sessionWindow', label: t('appearance.sessionWindow') }` em Appearance → Sidebar views; salvar inclui `sessionWindow`. Desligar não fecha a janela aberta.
  - Chaves i18n (en): `sidebar.detachSessions` "Open sessions in a separate window", `appearance.sessionWindow` "Separate sessions window button", `sessionWindow.returnToMain` "Return to main window", `sessionWindow.placeholder` "This project's sessions are open in another window", `sessionWindow.show` "Show", `sessionWindow.bringBack` "Bring back". zh-CN com traduções equivalentes.

- [ ] **Step 1: Testes** em `sidebar.test.ts`: botão presente no card ativo com a preferência ligada, ausente com ela desligada e no Temporary; clique chama `openSessionWindow(id)`; com o projeto destacado o botão tem estado selecionado e o clique chama `closeSessionWindow`; card destacado tem `.detached-window`; clique no card destacado chama `revealProject`.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** Implementar (seguir `/ui-dev`).
- [ ] **Step 4:** `npm test` → PASS; `npm run build` ok.
- [ ] **Step 5: Checkpoint.**

---

### Task 11: Verificação ponta a ponta, revisão e documentação

**Files:**
- Modify: `CLAUDE.md` (bullet novo em "Key Components": janela de sessões — modelo de um renderer/dois documentos, views, `viewShowsSession`, `commandTargetProjectId`, `revealSession`/`revealProject`, `getMainWindow`, menu com `source`, `sessionWindowBounds`, não-persistência)

- [ ] **Step 1:** `npm test` e `npm run build` → verdes.
- [ ] **Step 2:** Rodar o app (skill `run`) e percorrer o roteiro manual da seção "Testes" do spec, mais os 5 itens de Review Focus, inclusive dois monitores com escalas diferentes no Windows.
- [ ] **Step 3:** `/code-review` e `/simplify` (automático, sem perguntar); aplicar o que fizer sentido; `npm test` de novo.
- [ ] **Step 4:** Atualizar `CLAUDE.md`.
- [ ] **Step 5: Checkpoint** e reportar ao usuário (commit só se ele pedir, via `/commit`).

---

## Spike result

Rodado automatizado (Electron via CDP, Windows 11, DPR 1, PTY = `cmd.exe` via `pty.createShell`, HOME isolado). Código do spike descartado.

**Método: `move`.** Plano B (`recreate` + serialize) não foi necessário nem testado.

**Regra obrigatória:** depois de cada `appendChild` do `.terminal-pane` em outro documento, chamar `terminal.open(xtermWrap)` de novo. Num terminal já aberto isso só troca `CoreBrowserService.window` para a janela nova (xterm 6, `CoreBrowserTerminal.open`), não recria nada. Sem isso o xterm segue agendando render no `requestAnimationFrame` da janela antiga (a nova congela se a principal estiver oculta/minimizada) e o monitor de DPR fica preso à janela antiga.

**WebGL:** não precisa descarregar/recarregar num move vivo. Ida/volta/ida mantendo o addon: contexto intacto, renderiza. Descarregar antes + `loadWebglWithFallback` depois também funciona (opcional). Se o canvas estiver com `getContext('webgl2').isContextLost()`, `dispose` + `loadWebglWithFallback` recupera.

**Passou (com evidência):** saída do PTY e digitação no documento novo (CDP `Input.insertText` → buffer), seleção com mouse (`getSelection`), `ownerDocument`/textarea no doc novo, foco no textarea filho, stylesheets via `new URL('styles.css'|'xterm.css', document.baseURI)` carregam (CSP ok), find bar aberta via `showSearchBar` aparece dentro do pane no filho e `findNext` acha/seleciona, hover + Ctrl+click de link (link provider: `hover` e `activate ctrl=true`, sublinhado visível), `resizeTo` + `fitTerminal` → cols/rows e `pty.resize` novos, DPR emulado 1→2 no filho → `coreBrowserService.dpr` 2 e canvas dobra, volta para `#terminal-container` (+ `open()`) com render e WebGL ok.

**Falhou / pegadinhas para a Task 8:**
- **Fechar a janela com pane dentro mata o pane:** o contexto WebGL é perdido sem evento `webglcontextlost` (então o `onContextLoss → dispose` nunca roda e fica caixa cinza), e **todos os listeners DOM dos nós do pane somem** (linkifier, mousedown/contextmenu/drag nossos). Recarregar WebGL não resolve os listeners. Correção verificada: mover os panes de volta para o documento principal **de forma síncrona** em `pagehide` (ou `beforeunload`/`unload`) do filho, ou antes de chamar `close()`. Com isso listeners e WebGL sobrevivem.
- **`BrowserWindow.getAllWindows()[0]` vira a janela filha:** `pty:data` do shell ia para o filho (que não tem listener) e nada chegava. Confirma a Task 2 (referência explícita à janela principal) — é bloqueante, não cosmético.
- **Ctrl+F no filho não abre a find bar:** o `keydown` de `keybindings.ts` está no `document` principal. O documento filho precisa do mesmo listener.
- **Ctrl+V (Windows) no filho não cola:** `attachClipboardCopyHandler` usa `navigator.clipboard.readText()` do principal → "Document is not focused". O do filho (`terminal.element.ownerDocument.defaultView.navigator.clipboard`) funciona. Copy (copy-on-select, Ctrl+C/Ctrl+Shift+C) vai por IPC `clipboard:write` e independe do documento.
- `setFocused` lê `document.activeElement` do principal; no filho a heurística de foco fica errada.
- `window.vibeyard` não existe no documento filho; todo código usa o do principal.
- Janela fechada: `devicePixelRatio` = 0 → nunca rodar `fit` num pane que ainda esteja num documento fechado.
- `window.open` de novo com o mesmo nome reusa a janela e navega para `about:blank`, apagando o DOM dela (visto por acidente, não isolado): guardar a referência e não reabrir.
- xterm guarda `_document` do primeiro `open()` (usado em mouse-tracking de apps TUI e pelo DOM renderer de fallback). Não testado com app que liga mouse reporting.
- Janelas ocluídas/ocultas param `requestAnimationFrame` (Chromium). No teste automatizado precisei de `--disable-features=CalculateNativeWinOcclusion`; uso real não é afetado.

**Não verificado — fica para o manual da Task 11:** dois monitores reais com escalas diferentes (só DPR emulado), nitidez visual, copy-on-select ligado na preferência (caminho é IPC), colar com o clipboard real do SO por Ctrl+V depois da correção, IME, `<webview>`.
