# Janela de sessões destacada (multi-monitor) — design

Data: 2026-11-07 · Status: rascunho para aprovação

## Intenção

O usuário trabalha com dois monitores. Quer manter o Vibeyard (sidebar, Active
Sessions, kanban, overview etc.) num monitor e **as sessões de um projeto** em
outro monitor, numa janela própria. Hoje o Vibeyard é uma janela só; para ver
mais terminais ao mesmo tempo, o único recurso é split/swarm dentro dela.

Sucesso = clicar num botão no card do projeto, arrastar a janela nova para o
outro monitor e trabalhar nas sessões daquele projeto ali — criando, fechando,
alternando sessões — enquanto a janela principal segue usável para o resto.

## Comportamento (decidido com o usuário)

1. **Botão novo** na fileira de ações do card do projeto na sidebar (ao lado de
   Git / arquivos / histórico). Clique → abre a **janela de sessões** com as
   sessões desse projeto.
2. **As sessões mudam de janela, não são espelhadas.** Enquanto o projeto está
   destacado, as sessões dele **não aparecem** na janela principal.
3. **Clicar no card de um projeto destacado** faz duas coisas: (a) traz a
   janela de sessões para a frente (foco + acima de outras janelas) e (b) torna
   o projeto ativo na janela principal **sem as sessões**: o card mostra
   normalmente Git, arquivos, histórico e o terminal do projeto, e a área
   central mostra um aviso "As sessões deste projeto estão na outra janela"
   com os botões **Mostrar** (foca a janela de sessões) e **Trazer de volta**
   (fecha a janela de sessões). Isso mantém Git/arquivos/histórico/terminal do
   projeto acessíveis enquanto ele está destacado. *(recomendação do
   assistente, aprovada pelo usuário)*
3b. **Quais abas vão para a janela de sessões:** sessões CLI e as abas abertas a
   partir delas (file reader, diff viewer, browser tab, MCP inspector, remote
   terminal). As abas de projeto **Overview (`project-tab`), Kanban e Team
   ficam na janela principal**: com o projeto destacado ativo, a barra de abas
   da principal mostra só essas, e o aviso do item 3 ocupa a área central
   quando nenhuma delas está selecionada. Uma aba nova desses três tipos criada
   com o projeto destacado vai para a principal; os demais tipos vão para a
   janela de sessões. *(recomendação do assistente, aprovada pelo usuário)*
4. **Voltar ao normal = fechar a janela de sessões.** As sessões continuam
   rodando (nenhum PTY é morto). No próximo clique no card, o projeto abre na
   janela principal como hoje.
5. **Um projeto destacado por vez.** Clicar no botão de destacar de *outro*
   projeto enquanto um já está destacado: a janela de sessões passa a mostrar o
   novo projeto e o anterior volta para a principal. *(decisão do assistente)*
6. **Gerenciamento completo de sessões na janela de sessões:** barra de abas
   daquele projeto com criar sessão (botão, menu de nova sessão customizada,
   Ctrl+T / Ctrl+Shift+N), fechar aba, renomear, reordenar, split e swarm.
   *(criar foi pedido pelo usuário; o resto é decisão do assistente por ser
   parte de "gerenciar")*
7. **Nada é persistido.** Fechou e reabriu o Vibeyard → tudo na janela
   principal. Só a **posição e tamanho** da janela de sessões são lembrados,
   para a próxima abertura cair direto no outro monitor. *(decisão do
   assistente)*
8. **Preferência** em Preferences → Appearance → Sidebar views: mostrar/esconder
   o botão de destacar (padrão: visível). Pedido pelo usuário.
9. *(decisões do assistente, aceitas pelo usuário)*
   - Clicar numa sessão do projeto destacado no painel **Active Sessions** →
     ativa a sessão na janela de sessões e traz essa janela para a frente.
   - A janela de sessões tem um botão **"Voltar para a janela principal"**
     (mesmo efeito de fechar).
   - O card do projeto destacado ganha um **indicador visual** (ex.: ícone do
     botão em estado ativo + classe `.detached-window` no card).

## Não-objetivos

- Arrastar a janela de sessões sobre a principal para "acoplar de volta"
  (fica para uma segunda etapa).
- Mais de um projeto destacado ao mesmo tempo / mais de uma janela extra.
- Sidebar, Active Sessions, Discussions, painéis Git/arquivos, overview na
  janela de sessões.
- O **terminal do projeto** (painel inferior `#project-terminal-panel`, shell
  do projeto) — continua só na janela principal.
- Persistir o destaque entre reinícios.
- Projeto **Temporary** (não tem botões de ação; fica fora).

## Anti-objetivos (falha mesmo que "funcione")

- Duas janelas gravando `state.json` e uma apagando a outra.
- Terminal que abre vazio / perde o histórico ao mudar de janela.
- Fechar a janela de sessões matar PTYs, disparar o diálogo de "confirmar
  saída" ou encerrar o app.
- Regressão na janela principal com o recurso sem uso (render, foco, seleção —
  ver bullet "Renders must not touch pane DOM" no CLAUDE.md).

## Arquitetura (decisão do assistente)

### Um renderer só, dois documentos

A janela de sessões é aberta **pelo renderer principal** via
`window.open('about:blank', 'vibeyard-sessions', …)`. Ela é same-origin com o
opener, então **todo o código continua rodando no renderer principal**: o mesmo
`AppState`, os mesmos stores (`session-activity`, `session-cost`,
`session-unread`…), os mesmos listeners de IPC (`pty:data`, hooks). A janela
nova é só **mais um documento** onde o renderer principal desenha DOM.

Consequências:

- **Estado:** nenhuma mudança de dono. Só o renderer principal persiste. Sem
  sincronização entre janelas.
- **Processo principal:** quase intocado. `getAllWindows()[0]` continua correto
  desde que a janela principal seja sempre a primeira — ver "Processo
  principal" abaixo; a escolha robusta é trocar esses usos por uma referência
  explícita à janela principal.
- **PTY:** dados continuam chegando ao renderer principal e indo para o xterm
  da sessão, onde quer que o DOM dele esteja.

Alternativa descartada: segundo `BrowserWindow` carregando `index.html` num
"modo sessões". Exigiria dois `AppState` sincronizados, roteamento de
`pty:data`/hooks por janela e impedir que os dois renderers criem xterm (e
redimensionem o PTY) para a mesma sessão. Muito mais código e mais risco.

Precedente: as "auxiliary windows" do VS Code usam exatamente este modelo
(mesmo renderer, `window.open`, DOM movido entre documentos, incluindo
terminais xterm).

### Abertura e controle da janela (processo principal)

- `setWindowOpenHandler` em `main.ts` hoje nega tudo. Passa a **permitir só**
  `about:blank` com `frameName === 'vibeyard-sessions'`, retornando
  `overrideBrowserWindowOptions` (título, ícone, `backgroundColor`, bounds
  salvos, `minWidth/minHeight`, `webPreferences` sem preload, sem
  `nodeIntegration`, `contextIsolation: true`, `webviewTag: true` — necessário
  se abas de browser forem movidas). Todo o resto continua negado/aberto
  externamente.
- `webContents.on('did-create-window')` guarda a referência da janela de
  sessões no processo principal e:
  - aplica o guard `will-navigate` também nela (só permite `about:blank`);
  - salva bounds em `move`/`resize` (debounce) num campo top-level do estado
    (ex.: `state.sessionWindowBounds`), validado contra `screen.getAllDisplays()`
    ao reabrir (se o monitor sumiu, abre centralizado na principal);
  - `closed` → avisa o renderer (o renderer também detecta via `unload`/
    `closed` da referência `window.open`, o que for mais confiável).
- IPC novo (namespace `sessionWindow` no preload da principal):
  - `sessionWindow:focus` → `show()` + `focus()` + `moveTop()` na janela de
    sessões (`window.focus()` do opener não garante trazer para frente em
    todas as plataformas).
  - `sessionWindow:close`.
- A janela de sessões **não** participa do fluxo de confirmação de saída
  (`close` dela fecha direto). Fechar a **principal** fecha a de sessões junto
  (a de sessões é `parent`-less mas é fechada explicitamente no `close`
  confirmado da principal, ou pelo próprio renderer ao descarregar).
- Os 16 usos de `BrowserWindow.getAllWindows()[0]` (ipc-handlers, main,
  auto-updater) passam a usar a janela principal explícita (ex.: exportar
  `getMainWindow()` de `main.ts` ou de um módulo `windows.ts`). Com duas
  janelas, a ordem de `getAllWindows()` não é garantida.
- `IPC` que usa `BrowserWindow.fromWebContents(event.sender)` (ex.: diálogos)
  continua funcionando: como todo IPC sai do renderer principal, o sender é a
  janela principal. Diálogos nativos abertos a partir da janela de sessões
  (ex.: escolher pasta no diálogo de nova sessão) precisam receber a janela de
  sessões como pai, senão aparecem no outro monitor — o builder decide o
  mecanismo (ex.: parâmetro "janela alvo" no IPC, ou usar a janela focada).

### Renderer: de singletons para "views"

Hoje `tab-bar/*` e `split-layout.ts` são singletons ligados a
`appState.activeProject` e a nós fixos de `index.html` (`#tab-list`,
`#terminal-container`, botões `#btn-add-session` etc. via `getElementById` no
topo do módulo). Esse é o grosso do trabalho.

Refatorar para uma **view de sessões** instanciável:

```
interface SessionsView {
  doc: Document;                     // document da janela onde desenha
  root: HTMLElement;                 // contém tab bar + container de panes
  projectId(): string | null;        // qual projeto esta view mostra
}
```

- **View principal:** `projectId()` = projeto ativo. Quando o ativo é o
  destacado, a view principal filtra para as abas de projeto
  (`project-tab`/`kanban`/`team`) e mostra o aviso do item 3 no lugar dos
  terminais.
- **View destacada:** `projectId()` = projeto destacado (fixo), filtrando para
  as demais abas (item 3b).
- O filtro "quais sessões esta view mostra" é um predicado DOM-free por view
  (ex.: `viewShowsSession(view, project, session)`), e tudo que hoje itera
  `tabSessions(project)` para desenhar/ciclar/indexar abas (tab bar,
  `cycleSessionId`, `sessionIdAtIndex`, `reorderSessionInProject`,
  split/swarm panes, `renderLayout`) passa a iterar as abas **da view**. O
  `activeSessionId` do projeto pertence à view destacada; a view principal
  guarda a própria aba de projeto selecionada de forma transitória.
  *Ponto de atenção:* `project.layout` (split/swarm) passa a valer para a view
  destacada; a principal, com o projeto destacado, fica sempre em modo abas.
- `renderLayout`, `onSessionAdded` (o `isActive` vira "este projeto está
  visível em alguma view"), `focusPane`, `fitAllVisible`, swarm, tab list,
  menus de aba e scroll de abas passam a receber/consultar a view em vez de
  `appState.activeProject` e do `document` global.
- Os **registros de panes** (terminal, file reader, browser tab, kanban…)
  continuam globais por `sessionId`. O que muda é **em qual container** a view
  anexa o elemento. Os `attach*ToContainer` já no-opam quando o elemento já
  está no container — preservar essa regra.
- `hideAllPanes()` e afins hoje escondem tudo; com duas views precisam esconder
  só os panes **daquela view**, senão a view principal esconde os terminais da
  janela de sessões a cada render.
- **Ao destacar:** a view destacada é criada no documento novo e os elementos
  dos panes das sessões do projeto são movidos para o container dela. **Ao
  fechar:** voltam para o container da view principal (escondidos, até o
  projeto ser ativado de novo).

### xterm entre documentos (maior risco técnico)

Mover o elemento DOM de um terminal xterm para outro documento:

- xterm 6 (`@xterm/xterm ^6.0.0`) tem suporte a troca de janela
  (`CoreBrowserService` acompanha o `window` do elemento) — foi feito para as
  auxiliary windows do VS Code. **Precisa ser validado num spike** antes do
  resto: mover, digitar, selecionar, colar, Cmd+F (find bar é anexada dentro
  do pane), links clicáveis, resize, monitores com DPI diferentes.
- WebGL (`terminal-utils.ts`): o contexto pode ser perdido ao trocar de
  documento. Já existe `onContextLoss → dispose` (cai para o renderer padrão).
  Melhor: descarregar o WebglAddon antes do move e recarregar depois.
- **Plano B** se o move direto não funcionar bem: descartar o `Terminal` e
  criar um novo no documento destino, restaurando o buffer com
  `@xterm/addon-serialize` (já é dependência, usado em `sharing/peer-host.ts`).
  O PTY não é afetado. Vale o mesmo para o caminho de volta.
- `<webview>` (abas de browser) recarrega ao ser movido entre documentos.
  Aceitável: documentar; o builder pode avaliar restaurar a URL atual.

### Coisas que assumem o `document`/`window` global

- **CSS:** o documento novo precisa dos mesmos stylesheets (`styles.css`,
  `vendor/gridstack.min.css`) e dos mesmos atributos de tema no `<html>`
  (`data-theme`, variáveis). Copiar os `<link>` do documento principal ao abrir
  e espelhar mudanças de tema (`preferences-changed`).
- **Atalhos:** o `keydown` global (keybindings/shortcuts) é registrado no
  `document` principal. Registrar também no documento da janela de sessões; os
  atalhos de sessão (nova sessão, fechar aba, próxima/anterior aba, Cmd+F,
  zoom de fonte se houver) agem **na view da janela onde o evento ocorreu**.
  Atalhos que não fazem sentido lá (toggle sidebar, Git panel, Quick Open,
  terminal do projeto) são ignorados ou trazem a principal para frente —
  decisão do builder, desde que nada quebre.
- **Modais:** `modal.ts` usa nós fixos `#modal-overlay` do documento
  principal. Para o diálogo de **nova sessão** (e confirmações de fechar/
  renomear disparadas na janela de sessões) aparecerem na janela de sessões, o
  modal precisa poder ser montado no documento da view de origem. Mesma coisa
  para menus de contexto (aba, terminal), hover cards e custom-select, que
  criam elementos em `document.body` e escutam `document` para fechar.
- **Listeners de `window`:** `resize` (refit), `requestAnimationFrame`,
  `getComputedStyle`, `document.activeElement` (usado em `focusPane`),
  `ResizeObserver` — usar o `window`/`document` da view (`el.ownerDocument`,
  `ownerDocument.defaultView`).
- **Menu nativo:** `src/main/menu.ts` manda os aceleradores para
  `BrowserWindow.getFocusedWindow().webContents`. Com a janela de sessões em
  foco, isso cai numa página sem preload e o atalho morre em silêncio.
  Rotear sempre para o renderer principal com uma indicação de qual janela
  estava em foco, para o renderer agir na view certa. Itens como
  `close`/`reload` do menu também precisam decidir: fechar/recarregar a
  janela de sessões não pode recarregar o app nem matar sessões.
- **Zoom:** aplicar o mesmo fator de zoom da janela principal na de sessões.
- **i18n:** strings novas em `locales/en.json` e `locales/zh-CN.json`.

### Integração com o resto do app

- **Estado de destaque** é transitório e só do renderer:
  `appState.detachedWindowProjectId` (não persistido) + evento
  `detached-window-changed`. Ou um módulo próprio
  (`session-window.ts`) com observer, no padrão de `session-unread.ts`.
- **Sidebar (`sidebar.ts`):** botão novo na fileira de ações
  (`buildProjectActions`), que só existe no card **ativo**
  (`isActive && !project.temporary`) — então destacar é feito a partir do
  projeto ativo; para destacar outro, o usuário ativa o card dele e clica.
  Gated pela preferência. No card do destacado (que pode estar ativo, item 3)
  o botão aparece em estado "ativo"; clicar nele de novo traz as sessões de
  volta (toggle). Indicador `.detached-window` no card mesmo quando inativo.
- **Ao destacar o projeto ativo:** ele continua ativo na principal, agora no
  modo do item 3 (abas de projeto + aviso). *(atualizado conforme o item 3)*
- **Ativar o projeto destacado** (`setActiveProject(destacadoId)`) vindo de
  qualquer lugar (card, Active Sessions, board cards, `vibeyard-ctl
  new-session --focus`, `activateExistingSession`, busca global/resume) →
  ativa normalmente na principal (modo do item 3) **e** foca a janela de
  sessões. Caminhos que focam uma **sessão** do destacado focam só a janela de
  sessões. Centralizar num ponto (ex.: helper `revealProject(id)` /
  `revealSession(projectId, sessionId)`), não espalhar `if`s.
- **`setActiveSession`** de uma sessão do destacado já funciona (não troca
  projeto); somar o foco da janela de sessões nos caminhos de "focar sessão".
- **Remover projeto destacado** ou **`removeAllSessions`** nele: remover
  projeto fecha a janela de sessões; sem sessões, a janela mostra o estado
  vazio com o botão de nova sessão.
- **Sessões detached** (aba fechada, sessão viva) do projeto destacado: mesmas
  regras de hoje, só que na view destacada.
- **Preferência:** `sidebarViews.sessionWindow` (padrão `true`) em
  `types.ts`, default em `state.ts`, toggle em `appearance-section.ts`.
  Desligar com um projeto destacado só esconde o botão; a janela aberta fica.
  *(decisão do assistente)*
- **Título da janela:** `"<nome do projeto> — Vibeyard"`, atualizado em rename
  do projeto.

## Sugestão de ordem (o builder pode reordenar)

1. **Spike:** `window.open` + mover um xterm vivo para lá e de volta; validar a
   lista do item "xterm entre documentos". Decide entre move direto e plano B.
2. Processo principal: janela principal explícita, handler de `window.open`,
   IPC `sessionWindow`, bounds.
3. Refatorar `split-layout` + `tab-bar` em views, sem mudança de
   comportamento (view principal única) — testes existentes devem passar.
4. View destacada + botão + preferência + redirecionamento de
   `setActiveProject`.
5. Modais/menus/atalhos no documento da view.
6. Testes, `/code-review`, `/simplify`, atualizar CLAUDE.md (novo bullet de
   arquitetura).

## Testes

- Helpers DOM-free novos com teste unitário (ex.: qual view mostra qual
  projeto, redirecionamento de `setActiveProject`, validação de bounds contra
  displays).
- Testes existentes de `split-layout`, `tab-bar`, `sidebar`, `pane-focus`,
  `pane-order` continuam passando após a refatoração.
- Teste manual (o `/run` do projeto): destacar, criar/fechar/renomear sessão
  na janela nova, split/swarm lá, clicar no card destacado, Active Sessions,
  fechar a janela (sessões voltam, PTYs vivos), destacar outro projeto,
  remover projeto destacado, quit com janela aberta, reiniciar (nada
  destacado, bounds lembrados), monitores com escala diferente no Windows.

## Deixado para o builder

- Nomes de módulos/arquivos/funções e a forma exata da interface de view.
- Ícone do botão (seguir `/ui-dev`: componentes e variáveis CSS existentes).
- Mecanismo para diálogos nativos abrirem sobre a janela certa.
- Quais atalhos da principal são ignorados na janela de sessões.
- Detalhes do placeholder da principal (se algum caso cair nele).
