import type { ThinkingEffort } from "./lmStudioClient";

interface ThinkingSettings {
  enabled: boolean;
  effort: ThinkingEffort;
}

interface ModelBootstrapState {
  items: string[];
  selected: string;
  baseUrl: string;
  info?: string;
  error?: string;
}

export function buildWebviewHtml(
  thinking: ThinkingSettings,
  bootstrap?: ModelBootstrapState
): string {
    const nonce = createNonce();
    const modelItems = Array.isArray(bootstrap?.items)
      ? bootstrap.items.map((item) => String(item || "").trim()).filter((item) => item.length > 0)
      : [];
    const selectedModel =
      typeof bootstrap?.selected === "string" && bootstrap.selected.trim().length > 0
        ? bootstrap.selected.trim()
        : modelItems[0] ?? "";
    const selectItems = modelItems.length > 0 ? modelItems : [selectedModel].filter((item) => item.length > 0);
    const optionItems = selectItems.length > 0 ? selectItems : [""];
    const optionsHtml = optionItems
      .map((model) => {
        const safeValue = escapeHtmlAttr(model);
        const safeLabel = model.length > 0 ? escapeHtmlText(model) : "(No models yet)";
        const selectedAttr = model === selectedModel ? " selected" : "";
        return `<option value="${safeValue}"${selectedAttr}>${safeLabel}</option>`;
      })
      .join("");
    const initialBaseUrl = escapeHtmlAttr((bootstrap?.baseUrl || "").trim());
    const initialModelInfo = escapeHtmlText(String(bootstrap?.error || bootstrap?.info || "").trim());
    const initialModelInfoClass = bootstrap?.error ? "hint error" : "hint";

    return String.raw`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
  <title>Local Agent</title>
  <style>
    :root {
      --bg-0: #0f1c22;
      --bg-1: #122933;
      --card: rgba(14, 28, 36, 0.76);
      --card-strong: rgba(10, 22, 30, 0.9);
      --line: rgba(127, 182, 168, 0.26);
      --line-strong: rgba(127, 182, 168, 0.45);
      --text: #eaf7f3;
      --text-soft: #9bc4b8;
      --accent: #4bd7ab;
      --accent-2: #2cb88e;
      --warn: #f0ae5a;
      --danger: #ef7b7b;
      --ok: #5cda9f;
      --shadow: 0 18px 48px rgba(0, 0, 0, 0.35);
    }

    * {
      box-sizing: border-box;
    }

    html,
    body {
      height: 100%;
    }

    body {
      margin: 0;
      padding: 12px;
      color: var(--text);
      background:
        radial-gradient(circle at 10% -10%, #1f4f53 0%, transparent 35%),
        radial-gradient(circle at 95% 5%, #153b4f 0%, transparent 28%),
        linear-gradient(160deg, var(--bg-0) 0%, var(--bg-1) 100%);
      font-family: "Space Grotesk", "IBM Plex Sans", "Segoe UI", sans-serif;
      font-size: 12px;
      line-height: 1.5;
      min-height: 100%;
      overflow: auto;
    }

    .app {
      min-height: 100%;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(300px, 0.9fr);
      gap: 12px;
      align-items: start;
    }

    .col {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .col-main {
      min-width: 0;
    }

    .col-side {
      min-width: 0;
    }

    .panel {
      border: 1px solid var(--line);
      border-radius: 16px;
      background: linear-gradient(180deg, rgba(21, 39, 47, 0.92) 0%, var(--card) 100%);
      box-shadow: var(--shadow);
      backdrop-filter: blur(8px);
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .panel.hero {
      background: linear-gradient(155deg, rgba(19, 44, 52, 0.95) 0%, rgba(9, 23, 30, 0.95) 100%);
      border-color: var(--line-strong);
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .title {
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.2px;
      color: #f3fffc;
    }

    .hint {
      color: var(--text-soft);
      font-size: 11px;
      line-height: 1.45;
    }

    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid rgba(127, 182, 168, 0.42);
      background: rgba(35, 78, 75, 0.4);
      color: #dffff3;
      padding: 4px 10px;
      border-radius: 999px;
      font-weight: 700;
      max-width: 100%;
      white-space: nowrap;
      text-overflow: ellipsis;
      overflow: hidden;
    }

    .fields {
      display: grid;
      gap: 8px;
    }

    .row {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }

    .grow {
      flex: 1;
      min-width: 150px;
    }

    .control-label {
      color: var(--text-soft);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.45px;
      margin-bottom: 4px;
    }

    textarea, select, input, button {
      font: inherit;
    }

    textarea,
    select,
    input[type="text"] {
      width: 100%;
      border: 1px solid rgba(129, 186, 171, 0.35);
      border-radius: 12px;
      background: rgba(5, 14, 20, 0.44);
      color: #ecfffa;
      transition: border-color 140ms ease, box-shadow 140ms ease, background 140ms ease;
    }

    textarea:focus,
    select:focus,
    input[type="text"]:focus {
      outline: none;
      border-color: rgba(94, 216, 176, 0.86);
      box-shadow: 0 0 0 3px rgba(56, 186, 146, 0.18);
      background: rgba(5, 14, 20, 0.62);
    }

    select,
    input[type="text"] {
      padding: 9px 10px;
      min-height: 36px;
    }

    textarea {
      min-height: 128px;
      resize: vertical;
      padding: 11px 12px;
      line-height: 1.5;
    }

    textarea::placeholder,
    input::placeholder {
      color: rgba(164, 199, 189, 0.75);
    }

    .task-actions {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
    }

    button {
      border: 1px solid rgba(132, 190, 174, 0.3);
      border-radius: 12px;
      padding: 9px 10px;
      background: rgba(28, 55, 59, 0.66);
      color: #e8fff8;
      cursor: pointer;
      font-weight: 700;
      transition: transform 100ms ease, border-color 120ms ease, background 120ms ease;
    }

    button:hover {
      border-color: rgba(124, 210, 181, 0.64);
      background: rgba(36, 74, 78, 0.78);
      transform: translateY(-1px);
    }

    button.primary {
      border-color: rgba(76, 229, 181, 0.68);
      background: linear-gradient(180deg, var(--accent) 0%, var(--accent-2) 100%);
      color: #03241b;
    }

    button.warn {
      border-color: rgba(239, 123, 123, 0.58);
      background: rgba(103, 36, 44, 0.75);
      color: #ffe7e7;
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.5;
      transform: none;
    }

    .toggle-wrap {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 8px 10px;
      border-radius: 12px;
      border: 1px solid rgba(130, 186, 171, 0.35);
      background: rgba(8, 20, 25, 0.48);
      color: #d7f4eb;
      min-height: 36px;
    }

    .toggle-wrap input[type="checkbox"] {
      width: 14px;
      height: 14px;
      accent-color: var(--accent);
      margin: 0;
    }

    .meta-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .metric {
      border: 1px solid rgba(129, 186, 171, 0.3);
      border-radius: 12px;
      background: rgba(8, 20, 25, 0.5);
      padding: 9px;
    }

    .metric .k {
      color: var(--text-soft);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }

    .metric .v {
      font-size: 15px;
      font-weight: 700;
      margin-top: 2px;
      color: #f1fffb;
    }

    .progress {
      border: 1px solid rgba(129, 186, 171, 0.32);
      border-radius: 999px;
      height: 10px;
      overflow: hidden;
      background: rgba(8, 20, 25, 0.56);
    }

    .progress > div {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #41d9a9 0%, #6dd4f6 100%);
      transition: width 130ms ease;
    }

    .list,
    .activity,
    .logs {
      overflow: auto;
      border: 1px solid rgba(129, 186, 171, 0.28);
      border-radius: 12px;
      background: rgba(6, 16, 21, 0.5);
      padding: 8px;
      max-height: min(42vh, 420px);
    }

    .list {
      list-style: none;
      margin: 0;
      display: grid;
      gap: 7px;
    }

    .activity {
      display: grid;
      gap: 7px;
    }

    .item,
    .activity-card {
      border: 1px solid rgba(129, 186, 171, 0.26);
      border-radius: 11px;
      padding: 8px;
      background: rgba(15, 33, 39, 0.74);
      white-space: pre-wrap;
      word-break: break-word;
    }

    .item[data-status="in_progress"] {
      border-color: rgba(240, 174, 90, 0.76);
      background: rgba(80, 58, 21, 0.45);
    }

    .item[data-status="done"] {
      border-color: rgba(92, 218, 159, 0.7);
      background: rgba(20, 64, 48, 0.48);
    }

    .item[data-status="failed"] {
      border-color: rgba(239, 123, 123, 0.7);
      background: rgba(86, 34, 43, 0.46);
    }

    .activity-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }

    .history-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      margin-bottom: 6px;
      flex-wrap: wrap;
    }

    .history-meta {
      color: var(--text-soft);
      font-size: 10px;
    }

    .history-btn {
      border: 1px solid rgba(129, 186, 171, 0.45);
      background: rgba(33, 75, 72, 0.64);
      color: #e1fff5;
      border-radius: 9px;
      font-size: 11px;
      padding: 5px 8px;
      font-weight: 700;
    }

    .badge {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      border-radius: 999px;
      padding: 2px 8px;
      background: rgba(63, 136, 118, 0.35);
      color: #dbfff3;
      border: 1px solid rgba(109, 184, 162, 0.56);
    }

    .badge.blocked {
      background: rgba(141, 96, 26, 0.4);
      color: #ffe8b9;
      border-color: rgba(240, 174, 90, 0.72);
    }

    .badge.recovery {
      background: rgba(77, 59, 114, 0.45);
      color: #e7d7ff;
      border-color: rgba(169, 134, 231, 0.65);
    }

    .mono {
      font-family: "IBM Plex Mono", "Cascadia Mono", monospace;
      font-size: 11px;
    }

    .logs {
      white-space: pre-wrap;
      word-break: break-word;
    }

    .chat-thread {
      display: grid;
      gap: 8px;
      max-height: min(34vh, 360px);
      overflow-y: auto;
    }

    .chat-item {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 10px 12px;
      background: linear-gradient(180deg, rgba(17, 23, 31, 0.96) 0%, rgba(12, 18, 26, 0.96) 100%);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02);
      white-space: normal;
      word-break: break-word;
    }

    .chat-item.user {
      border-color: rgba(95, 150, 255, 0.44);
      background: linear-gradient(180deg, rgba(18, 43, 76, 0.9) 0%, rgba(14, 33, 58, 0.92) 100%);
    }

    .chat-item.assistant {
      border-color: rgba(92, 105, 132, 0.48);
      background: linear-gradient(180deg, rgba(26, 30, 37, 0.96) 0%, rgba(21, 24, 30, 0.96) 100%);
    }

    .chat-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
      font-size: 10px;
      color: var(--text-soft);
      border-bottom: 1px dashed rgba(129, 186, 171, 0.26);
      padding-bottom: 4px;
    }

    .chat-role {
      font-weight: 700;
      letter-spacing: 0.35px;
      text-transform: uppercase;
      color: #e9fff9;
    }

    .chat-role.assistant-model {
      text-transform: none;
      font-size: 11px;
      letter-spacing: 0.1px;
      color: #d5deef;
      font-weight: 600;
    }

    .chat-time {
      opacity: 0.9;
    }

    .chat-content {
      line-height: 1.55;
      color: #ecfffa;
      overflow-x: auto;
      font-size: 15px;
    }

    .chat-content h1,
    .chat-content h2,
    .chat-content h3,
    .chat-content h4,
    .chat-content h5,
    .chat-content h6 {
      margin: 8px 0 6px;
      line-height: 1.35;
    }

    .chat-content p {
      margin: 8px 0;
    }

    .chat-content ul,
    .chat-content ol {
      margin: 6px 0 6px 18px;
      padding: 0;
      display: grid;
      gap: 3px;
    }

    .chat-content pre {
      margin: 10px 0;
      padding: 11px;
      border-radius: 8px;
      border: 1px solid rgba(115, 132, 158, 0.22);
      background: rgba(9, 13, 20, 0.86);
      overflow-x: auto;
    }

    .chat-content code {
      font-family: "IBM Plex Mono", "Cascadia Mono", monospace;
      font-size: 12px;
    }

    .chat-content p code,
    .chat-content li code {
      background: rgba(8, 14, 24, 0.95);
      border: 1px solid rgba(115, 132, 158, 0.2);
      border-radius: 5px;
      padding: 1px 5px;
    }

    .chat-content table {
      width: 100%;
      border-collapse: collapse;
      margin: 8px 0;
      font-size: 11px;
    }

    .chat-content th,
    .chat-content td {
      border: 1px solid rgba(129, 186, 171, 0.28);
      padding: 6px;
      text-align: left;
      vertical-align: top;
    }

    .chat-content th {
      background: rgba(49, 54, 64, 0.82);
      font-weight: 700;
    }

    .chat-content a {
      color: #6f96ff;
      text-decoration: underline;
    }

    .chat-thought {
      margin: 2px 0 10px;
      border: 1px solid rgba(122, 135, 156, 0.3);
      border-radius: 10px;
      background: rgba(31, 37, 47, 0.72);
      overflow: hidden;
    }

    .chat-thought-summary {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      user-select: none;
      padding: 7px 9px;
      color: #cad4e7;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.2px;
      border-bottom: 1px solid transparent;
    }

    .chat-thought[open] .chat-thought-summary {
      border-bottom-color: rgba(122, 135, 156, 0.3);
    }

    .chat-thought-summary::before {
      content: "▸";
      font-size: 11px;
      transform: translateY(-0.5px);
      color: #9fb1d3;
    }

    .chat-thought[open] .chat-thought-summary::before {
      content: "▾";
    }

    .chat-thought-content {
      padding: 8px 10px;
      color: #b8c6df;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      max-height: 180px;
      overflow: auto;
      word-break: break-word;
    }

    .chat-modal {
      position: fixed;
      inset: 8px;
      z-index: 50;
      display: none;
      background: rgba(3, 10, 14, 0.75);
      backdrop-filter: blur(3px);
      border: 1px solid rgba(127, 182, 168, 0.24);
      border-radius: 14px;
      padding: 10px;
    }

    .chat-modal.open {
      display: block;
    }

    .chat-shell {
      height: 100%;
      display: grid;
      grid-template-rows: auto 1fr auto auto;
      gap: 8px;
      border: 1px solid rgba(127, 182, 168, 0.35);
      border-radius: 12px;
      background: linear-gradient(180deg, rgba(13, 35, 44, 0.95) 0%, rgba(8, 21, 28, 0.95) 100%);
      padding: 10px;
    }

    .chat-modal-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .chat-modal-thread {
      overflow: auto;
      border: 1px solid rgba(129, 186, 171, 0.32);
      border-radius: 10px;
      background: rgba(4, 16, 23, 0.6);
      padding: 8px;
      display: grid;
      gap: 8px;
    }

    .chat-thinking {
      border: 1px solid rgba(122, 135, 156, 0.24);
      border-radius: 10px;
      background: linear-gradient(180deg, rgba(26, 31, 41, 0.84) 0%, rgba(19, 23, 30, 0.74) 100%);
      padding: 8px 10px;
      color: #d3e0f8;
      min-height: 48px;
      max-height: 18vh;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.45;
      font-family: "IBM Plex Mono", "Cascadia Mono", monospace;
    }

    .chat-compose {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: end;
    }

    .chat-compose textarea {
      min-height: 70px;
      max-height: 26vh;
      resize: vertical;
    }

    .error {
      color: var(--danger);
    }

    .done {
      color: var(--ok);
    }

    body[data-density="compact"] .task-actions {
      grid-template-columns: 1fr 1fr;
    }

    body[data-density="compact"] .meta-grid {
      grid-template-columns: 1fr;
    }

    @media (max-width: 1200px) {
      .layout {
        grid-template-columns: minmax(0, 1fr);
      }

      .list,
      .activity,
      .logs {
        max-height: min(34vh, 360px);
      }
    }

    @media (max-width: 760px) {
      body {
        padding: 8px;
      }

      .task-actions {
        grid-template-columns: 1fr 1fr;
      }

      .list,
      .activity,
      .logs {
        max-height: min(30vh, 300px);
      }
    }
  </style>
</head>
<body>
  <div class="app">
    <div class="panel hero">
      <div class="header">
        <div class="title">Local Agent Coder</div>
        <div id="status" class="status-pill">Idle</div>
      </div>
      <div class="hint">Plan creates steps, Run Agent executes tools/file changes, Chat Only only talks to model.</div>
    </div>

    <div class="layout">
      <div class="col col-main">
        <div class="panel">
          <div class="header">
            <div class="title">Task</div>
            <div id="runMeta" class="hint">Mode: - | Model: - | Thinking: off</div>
          </div>

          <div class="fields">
            <div>
              <div class="control-label">API Base URL</div>
              <div class="row">
                <div class="grow">
                  <input id="baseUrlInput" type="text" value="${initialBaseUrl}" placeholder="LM Studio URL (e.g. http://127.0.0.1:1234/v1)" />
                </div>
                <button id="reloadModels" type="button" onclick="(function(){try{var api=acquireVsCodeApi();if(!api||typeof api.postMessage!=='function'){return;}var modelEl=document.getElementById('modelSelect');var baseUrlEl=document.getElementById('baseUrlInput');api.postMessage({type:'load_models',preferredModel:(modelEl&&modelEl.value)||'',baseUrl:(baseUrlEl&&baseUrlEl.value)||''});}catch(_){}})()">Reload Models</button>
              </div>
            </div>

            <div>
              <div class="control-label">Model</div>
              <select id="modelSelect">${optionsHtml}</select>
              <div id="modelInfo" class="${initialModelInfoClass}" style="margin-top:6px;">${initialModelInfo}</div>
            </div>

            <div>
              <div class="control-label">Reasoning</div>
              <div class="row">
                <label class="toggle-wrap">
                  <input id="thinkingToggle" type="checkbox" />
                  Thinking mode
                </label>
                <div style="width: 170px; max-width: 100%; display: grid; gap: 4px;">
                  <div class="hint" style="font-size: 10px;">Level</div>
                  <select id="thinkingEffort">
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                  </select>
                </div>
              </div>
              <div class="hint">Enable when task is complex and needs deeper reasoning.</div>
            </div>
          </div>

          <div class="control-label" style="margin-top:2px;">Request</div>
          <textarea id="prompt" placeholder="Describe exactly what to build, fix, or test..."></textarea>

          <div class="task-actions">
            <button id="planBtn" type="button">Plan Only</button>
            <button id="runBtn" class="primary" type="button">Run Agent</button>
            <button id="chatBtn" type="button">Chat Only</button>
            <button id="stopBtn" class="warn" type="button">Stop</button>
            <button id="clearSessionBtn" type="button">Clear Session</button>
          </div>
        </div>

        <div class="panel">
          <div class="header">
            <div class="title">Plan Progress</div>
            <div id="stepStats" class="hint">0/0 done</div>
          </div>
          <div class="progress"><div id="progressBar"></div></div>
          <ul id="plan" class="list"></ul>
        </div>
      </div>

      <div class="col col-side">
        <div class="panel">
          <div class="header">
            <div class="title">Chat (No Execute)</div>
            <div class="hint">Conversation only</div>
          </div>
          <div id="chatThread" class="chat-thread"></div>
        </div>

        <div class="panel">
          <div class="title">Token Usage</div>
          <div class="meta-grid">
            <div class="metric"><div class="k">Prompt</div><div id="tokPrompt" class="v">0</div></div>
            <div class="metric"><div class="k">Completion</div><div id="tokCompletion" class="v">0</div></div>
            <div class="metric"><div class="k">Total</div><div id="tokTotal" class="v">0</div></div>
            <div class="metric"><div class="k">Last Call</div><div id="tokLast" class="v">-</div></div>
          </div>
        </div>

        <div class="panel">
          <div class="header">
            <div class="title">History</div>
            <div class="hint">Saved per workspace</div>
          </div>
          <div id="history" class="activity"></div>
        </div>

        <div class="panel">
          <div class="header">
            <div class="title">Agent Activity</div>
            <div class="hint">Realtime action timeline</div>
          </div>
          <div id="activity" class="activity"></div>
        </div>

        <div class="panel">
          <div class="header">
            <div class="title">Logs</div>
            <div class="hint">Runtime debug</div>
          </div>
          <div id="logs" class="logs mono"></div>
        </div>
      </div>
    </div>
  </div>

  <div id="chatModal" class="chat-modal">
    <div class="chat-shell">
      <div class="chat-modal-head">
        <div class="title">Chat Session</div>
        <button id="closeChatModalBtn" type="button">Close Chat</button>
      </div>
      <div id="chatModalThread" class="chat-modal-thread"></div>
      <div id="chatThinking" class="chat-thinking">Thinking: idle</div>
      <div class="chat-compose">
        <textarea id="chatComposer" placeholder="Type message... (Enter to send, Shift+Enter for newline)"></textarea>
        <button id="chatSendBtn" class="primary" type="button">Send</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const postFatalToHost = (text) => {
      try {
        const api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
        if (api && typeof api.postMessage === "function") {
          api.postMessage({ type: "client_error", text });
        }
      } catch {
        // ignore fatal report failures
      }
    };

    try {
    const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
    if (!vscode || typeof vscode.postMessage !== "function") {
      throw new Error("acquireVsCodeApi unavailable in webview");
    }
    if (typeof window !== "undefined") {
      window.__localAgentMainReady = false;
    }
    vscode.postMessage({ type: "client_trace", text: "script_try_start" });
    const bootThinkingEnabled = ${thinking.enabled ? "true" : "false"};
    const bootThinkingEffort = ${JSON.stringify(thinking.effort)};

    const promptEl = document.getElementById("prompt");
    const statusEl = document.getElementById("status");
    const runMetaEl = document.getElementById("runMeta");
    const planBtn = document.getElementById("planBtn");
    const runBtn = document.getElementById("runBtn");
    const chatBtn = document.getElementById("chatBtn");
    const stopBtn = document.getElementById("stopBtn");
    const clearSessionBtn = document.getElementById("clearSessionBtn");
    const reloadModelsBtn = document.getElementById("reloadModels");
    const baseUrlInputEl = document.getElementById("baseUrlInput");
    const modelSelectEl = document.getElementById("modelSelect");
    const modelInfoEl = document.getElementById("modelInfo");
    const thinkingToggleEl = document.getElementById("thinkingToggle");
    const thinkingEffortEl = document.getElementById("thinkingEffort");
    const planEl = document.getElementById("plan");
    const progressBarEl = document.getElementById("progressBar");
    const stepStatsEl = document.getElementById("stepStats");
    const logsEl = document.getElementById("logs");
    const chatThreadEl = document.getElementById("chatThread");
    const historyEl = document.getElementById("history");
    const activityEl = document.getElementById("activity");
    const tokPromptEl = document.getElementById("tokPrompt");
    const tokCompletionEl = document.getElementById("tokCompletion");
    const tokTotalEl = document.getElementById("tokTotal");
    const tokLastEl = document.getElementById("tokLast");
    const chatModalEl = document.getElementById("chatModal");
    const closeChatModalBtn = document.getElementById("closeChatModalBtn");
    const chatModalThreadEl = document.getElementById("chatModalThread");
    const chatThinkingEl = document.getElementById("chatThinking");
    const chatComposerEl = document.getElementById("chatComposer");
    const chatSendBtn = document.getElementById("chatSendBtn");

    const state = {
      running: false,
      mode: "-",
      model: "-",
      thinkingEnabled: Boolean(bootThinkingEnabled),
      thinkingEffort: String(bootThinkingEffort || "medium")
    };
    const streamNodes = new Map();
    const thoughtState = {
      active: false,
      startedAt: 0,
      text: ""
    };

    const applyResponsiveDensity = () => {
      const width = Math.max(window.innerWidth || 0, document.documentElement ? document.documentElement.clientWidth : 0);
      if (width <= 560) {
        document.body.dataset.density = "compact";
      } else if (width <= 960) {
        document.body.dataset.density = "cozy";
      } else {
        document.body.dataset.density = "comfortable";
      }
    };

    const post = (message) => {
      try {
        if (!vscode || typeof vscode.postMessage !== "function") {
          return;
        }
        vscode.postMessage(message);
      } catch {
        // ignore post failures
      }
    };
    const postTrace = (text) => post({ type: "client_trace", text });

    applyResponsiveDensity();
    window.addEventListener("resize", applyResponsiveDensity);

    window.addEventListener("error", (event) => {
      const text = (event && event.message) ? String(event.message) : "Unknown script error.";
      appendLog("UI error: " + text, "error");
      post({ type: "client_error", text });
    });

    window.addEventListener("unhandledrejection", (event) => {
      const reason = event && event.reason ? String(event.reason) : "Unknown promise rejection.";
      appendLog("UI promise rejection: " + reason, "error");
      post({ type: "client_error", text: reason });
    });

    const fmt = (n) => Number(n || 0).toLocaleString();

    const appendLog = (text, cls = "") => {
      if (!logsEl) {
        post({ type: "client_error", text: "logs element not found" });
        return;
      }
      const line = document.createElement("div");
      if (cls) {
        line.className = cls;
      }
      line.textContent = text;
      logsEl.appendChild(line);
      while (logsEl.childNodes.length > 500) {
        logsEl.removeChild(logsEl.firstChild);
      }
      logsEl.scrollTop = logsEl.scrollHeight;
    };

    const escapeHtml = (value) =>
      String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    const renderInlineMarkdown = (input) => {
      const tick = String.fromCharCode(96);
      let text = escapeHtml(input);
      const inlineCodePattern = new RegExp(tick + "([^" + tick + "]+)" + tick, "g");
      text = text.replace(inlineCodePattern, (_m, code) => "<code>" + escapeHtml(code) + "</code>");
      text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
      text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      return text;
    };

    const splitTableRow = (line) =>
      line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim());

    const normalizeModelText = (input) => {
      let text = String(input || "");
      const trimmed = text.trim();

      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === "object") {
            if (typeof parsed.content === "string") {
              text = parsed.content;
            } else if (parsed.output && typeof parsed.output === "string") {
              text = parsed.output;
            }
          }
        } catch {
          // ignore invalid JSON
        }
      } else if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (typeof parsed === "string") {
            text = parsed;
          }
        } catch {
          // ignore invalid JSON string
        }
      }

      text = text.replace(/^\[(Assistant|User)\s*\|\s*[^\]]+\]\s*/i, "");

      if (text.includes("\\n")) {
        const escapedCount = (text.match(/\\n/g) || []).length;
        const nativeCount = (text.match(/\n/g) || []).length;
        if (escapedCount > 0 && escapedCount >= nativeCount) {
          text = text.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\t/g, "    ");
        }
      }

      return text.replace(/\r\n/g, "\n");
    };

    const renderMarkdownLite = (input) => {
      const source = normalizeModelText(input);
      if (!source.trim()) {
        return "";
      }
      const tick = String.fromCharCode(96);
      const fence = tick + tick + tick;
      const codeBlocks = [];
      const codePattern = new RegExp(fence + "([a-zA-Z0-9_+-]*)\\n([\\s\\S]*?)" + fence, "g");
      let working = source.replace(codePattern, (_m, lang, code) => {
        const idx = codeBlocks.length;
        const language = String(lang || "").trim();
        const languageClass = language ? ' class="lang-' + escapeHtml(language) + '"' : "";
        codeBlocks.push("<pre><code" + languageClass + ">" + escapeHtml(String(code || "").replace(/\n$/, "")) + "</code></pre>");
        return "@@CODEBLOCK_" + idx + "@@";
      });

      const lines = working.split("\n");
      const out = [];
      let inUl = false;
      let inOl = false;
      const closeLists = () => {
        if (inUl) {
          out.push("</ul>");
          inUl = false;
        }
        if (inOl) {
          out.push("</ol>");
          inOl = false;
        }
      };

      for (let i = 0; i < lines.length; i += 1) {
        const raw = lines[i];
        const line = raw.trim();

        if (!line) {
          closeLists();
          continue;
        }

        if (line.includes("|") && i + 1 < lines.length) {
          const align = lines[i + 1].trim();
          if (/^\|?\s*:?[-\s|:]+:?\s*\|?\s*$/.test(align)) {
            closeLists();
            const header = splitTableRow(line);
            const rows = [];
            i += 2;
            while (i < lines.length) {
              const next = lines[i].trim();
              if (!next || !next.includes("|")) {
                i -= 1;
                break;
              }
              rows.push(splitTableRow(next));
              i += 1;
            }
            const th = header.map((cell) => "<th>" + renderInlineMarkdown(cell) + "</th>").join("");
            const body = rows
              .map((row) => "<tr>" + row.map((cell) => "<td>" + renderInlineMarkdown(cell) + "</td>").join("") + "</tr>")
              .join("");
            out.push("<table><thead><tr>" + th + "</tr></thead><tbody>" + body + "</tbody></table>");
            continue;
          }
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
          closeLists();
          const level = heading[1].length;
          out.push("<h" + level + ">" + renderInlineMarkdown(heading[2]) + "</h" + level + ">");
          continue;
        }

        const bullet = /^[-*]\s+(.*)$/.exec(line);
        if (bullet) {
          if (!inUl) {
            closeLists();
            inUl = true;
            out.push("<ul>");
          }
          out.push("<li>" + renderInlineMarkdown(bullet[1]) + "</li>");
          continue;
        }

        const numbered = /^\d+\.\s+(.*)$/.exec(line);
        if (numbered) {
          if (!inOl) {
            closeLists();
            inOl = true;
            out.push("<ol>");
          }
          out.push("<li>" + renderInlineMarkdown(numbered[1]) + "</li>");
          continue;
        }

        closeLists();
        if (/^@@CODEBLOCK_\d+@@$/.test(line)) {
          out.push(line);
          continue;
        }
        out.push("<p>" + renderInlineMarkdown(line) + "</p>");
      }

      closeLists();
      let html = out.join("\n");
      html = html.replace(/@@CODEBLOCK_(\d+)@@/g, (_m, idx) => {
        const at = Number(idx);
        return Number.isInteger(at) && at >= 0 && at < codeBlocks.length ? codeBlocks[at] : "";
      });
      return html;
    };

    const appendChatBubble = (container, role, text, timestamp, limit) => {
      if (!container) {
        return;
      }
      const item = document.createElement("div");
      item.className = "chat-item " + (role === "user" ? "user" : "assistant");

      const meta = document.createElement("div");
      meta.className = "chat-meta";
      const roleNode = document.createElement("span");
      roleNode.className = "chat-role";
      if (role === "assistant" && state.model && state.model !== "-") {
        roleNode.className = "chat-role assistant-model";
        roleNode.textContent = state.model;
      } else {
        roleNode.textContent = role === "user" ? "You" : "Assistant";
      }
      const safeTime = timestamp ? new Date(timestamp) : new Date();
      const timeLabel = isNaN(safeTime.getTime()) ? "-" : safeTime.toLocaleTimeString();
      const timeNode = document.createElement("span");
      timeNode.className = "chat-time";
      timeNode.textContent = timeLabel;
      meta.appendChild(roleNode);
      meta.appendChild(timeNode);

      if (role === "assistant" && thoughtState.text.trim()) {
        const elapsedMs = thoughtState.startedAt > 0 ? Date.now() - thoughtState.startedAt : 0;
        const elapsedSec = Math.max(0.01, elapsedMs / 1000);
        const thought = document.createElement("details");
        thought.className = "chat-thought";

        const summary = document.createElement("summary");
        summary.className = "chat-thought-summary";
        summary.textContent = "Thought for " + elapsedSec.toFixed(2) + " seconds";

        const content = document.createElement("div");
        content.className = "chat-thought-content";
        content.textContent = thoughtState.text.slice(-9000);

        thought.appendChild(summary);
        thought.appendChild(content);
        item.appendChild(meta);
        item.appendChild(thought);
      } else {
        item.appendChild(meta);
      }

      const body = document.createElement("div");
      body.className = "chat-content";
      body.innerHTML = renderMarkdownLite(text || "");
      item.appendChild(body);
      container.appendChild(item);
      while (container.childNodes.length > limit) {
        container.removeChild(container.firstChild);
      }
      container.scrollTop = container.scrollHeight;
    };

    const clearThinkingState = () => {
      thoughtState.active = false;
      thoughtState.startedAt = 0;
      thoughtState.text = "";
    };

    const ensureThinkingActive = () => {
      if (!thoughtState.active) {
        thoughtState.active = true;
        thoughtState.startedAt = Date.now();
      }
    };

    const updateThinkingStatus = (text) => {
      if (!chatThinkingEl) {
        return;
      }
      const next = String(text || "").trim();
      if (!next) {
        chatThinkingEl.textContent = "Thinking: idle";
        return;
      }
      if (thoughtState.active && thoughtState.startedAt > 0) {
        const elapsedSec = Math.max(0.01, (Date.now() - thoughtState.startedAt) / 1000);
        chatThinkingEl.textContent = "Thinking (" + elapsedSec.toFixed(2) + "s)\n" + next;
        return;
      }
      chatThinkingEl.textContent = "Thinking\n" + next;
    };

    const openChatModal = () => {
      if (!chatModalEl) {
        return;
      }
      chatModalEl.classList.add("open");
      if (chatComposerEl && typeof chatComposerEl.focus === "function") {
        chatComposerEl.focus();
      }
    };

    const closeChatModal = () => {
      if (!chatModalEl) {
        return;
      }
      chatModalEl.classList.remove("open");
    };

    const appendChatMessage = (role, text, timestamp) => {
      appendChatBubble(chatThreadEl, role, text, timestamp, 120);
      appendChatBubble(chatModalThreadEl, role, text, timestamp, 220);
      if (role === "assistant") {
        clearThinkingState();
      }
    };

    const sendChatMessage = () => {
      const composerPrompt = String((chatComposerEl && chatComposerEl.value) || "").trim();
      const taskPrompt = String((promptEl && promptEl.value) || "").trim();
      const prompt = composerPrompt || taskPrompt;
      if (!prompt) {
        appendLog("Chat input is empty.", "error");
        updateThinkingStatus("Empty chat input.");
        openChatModal();
        return;
      }

      const model = String((modelSelectEl && modelSelectEl.value) || "");
      const baseUrl = String((baseUrlInputEl && baseUrlInputEl.value) || "");
      const thinkingEnabled = Boolean(thinkingToggleEl && thinkingToggleEl.checked);
      const thinkingEffort = normalizeThinkingEffortUi(thinkingEffortEl ? thinkingEffortEl.value : state.thinkingEffort);

      state.thinkingEnabled = thinkingEnabled;
      state.thinkingEffort = thinkingEffort;
      syncThinkingControls();
      refreshRunMeta();
      openChatModal();
      ensureThinkingActive();
      thoughtState.text = "Waiting for response...";
      updateThinkingStatus(thoughtState.text);

      postTrace(
        "run clicked: mode=chat model=" +
          (model || "(empty)") +
          " baseUrl=" +
          (baseUrl || "(empty)") +
          " thinking=" +
          (thinkingEnabled ? thinkingEffort : "off")
      );
      post({ type: "run", mode: "chat", prompt, model, baseUrl, thinkingEnabled, thinkingEffort });

      if (chatComposerEl) {
        chatComposerEl.value = "";
      }
    };

    const updateStreamLog = (message) => {
      if (!logsEl) {
        return;
      }
      const key = String(message.streamId || "default");
      let line = streamNodes.get(key);
      if (line && !line.isConnected) {
        streamNodes.delete(key);
        line = undefined;
      }
      if (!line) {
        line = document.createElement("div");
        line.className = "hint mono";
        line.dataset.streamId = key;
        logsEl.appendChild(line);
        streamNodes.set(key, line);
      }

      const header = "[stream " + (message.stepId || "-") + " t" + String(message.turn || 0) + "] ";
      line.textContent = header + String(message.text || "");
      const streamText = String(message.text || "").trim();
      if (streamText) {
        ensureThinkingActive();
        thoughtState.text = streamText;
        updateThinkingStatus(streamText);
      }
      if (message.done) {
        line.className = "mono";
        streamNodes.delete(key);
        clearThinkingState();
        updateThinkingStatus("");
      }
      logsEl.scrollTop = logsEl.scrollHeight;
    };

    const appendActivity = (activity) => {
      if (!activityEl) {
        return;
      }
      const card = document.createElement("div");
      card.className = "activity-card";

      const head = document.createElement("div");
      head.className = "activity-head";

      const left = document.createElement("div");
      left.className = "mono";
      left.textContent = "[" + activity.stepId + " | t" + activity.turn + "] " + activity.actionType;

      const badge = document.createElement("div");
      badge.className = "badge " + (activity.status || "");
      badge.textContent = activity.status;

      head.appendChild(left);
      head.appendChild(badge);

      const detail = document.createElement("div");
      detail.className = "mono";
      detail.style.marginTop = "4px";
      detail.textContent = activity.detail || "";

      card.appendChild(head);
      card.appendChild(detail);
      activityEl.appendChild(card);

      while (activityEl.childNodes.length > 180) {
        activityEl.removeChild(activityEl.firstChild);
      }
      activityEl.scrollTop = activityEl.scrollHeight;
    };

    const renderHistory = (items) => {
      if (!historyEl) {
        return;
      }
      historyEl.innerHTML = "";

      const rows = Array.isArray(items) ? items : [];
      if (rows.length === 0) {
        const empty = document.createElement("div");
        empty.className = "hint";
        empty.textContent = "No saved history yet.";
        historyEl.appendChild(empty);
        return;
      }

      for (const row of rows) {
        const card = document.createElement("div");
        card.className = "activity-card";

        const top = document.createElement("div");
        top.className = "history-row";

        const meta = document.createElement("div");
        meta.className = "history-meta";
        meta.textContent =
          "[" + row.mode + "] " + (row.model || "-") + " | " + (row.status || "-") + " | " + (row.timestamp || "-");

        const useBtn = document.createElement("button");
        useBtn.className = "history-btn";
        useBtn.textContent = "Use Prompt";
        useBtn.addEventListener("click", () => {
          if (promptEl) {
            promptEl.value = row.userPrompt || "";
          }
        });

        top.appendChild(meta);
        top.appendChild(useBtn);

        const prompt = document.createElement("div");
        prompt.className = "mono";
        prompt.textContent = "Prompt: " + (row.userPrompt || "");

        const summary = document.createElement("div");
        summary.className = "mono";
        summary.style.marginTop = "4px";
        summary.textContent = "Summary: " + (row.preflightSummary || row.runSummary || "");

        const learning = document.createElement("div");
        learning.className = "mono";
        learning.style.marginTop = "4px";
        learning.textContent = "Learning: " + (row.learningNote || "(none)");

        const remainingList = Array.isArray(row.remainingSteps) ? row.remainingSteps : [];
        const remaining = document.createElement("div");
        remaining.className = "mono";
        remaining.style.marginTop = "4px";
        if (remainingList.length > 0) {
          remaining.textContent =
            "Remaining: " +
            remainingList
              .slice(0, 4)
              .map((step) => "[" + step.id + "] " + step.title + " (" + step.status + ")")
              .join(" | ");
        } else {
          remaining.textContent = "Remaining: (none)";
        }

        card.appendChild(top);
        card.appendChild(prompt);
        card.appendChild(summary);
        card.appendChild(learning);
        card.appendChild(remaining);
        historyEl.appendChild(card);
      }
    };

    const normalizeThinkingEffortUi = (value) => {
      const raw = String(value || "").trim().toLowerCase();
      if (raw === "low" || raw === "high") {
        return raw;
      }
      return "medium";
    };

    const syncThinkingControls = () => {
      state.thinkingEffort = normalizeThinkingEffortUi(state.thinkingEffort);
      if (thinkingToggleEl) {
        thinkingToggleEl.checked = Boolean(state.thinkingEnabled);
        thinkingToggleEl.disabled = Boolean(state.running);
      }
      if (thinkingEffortEl) {
        thinkingEffortEl.value = state.thinkingEffort;
        thinkingEffortEl.disabled = Boolean(state.running);
      }
    };

    const refreshRunMeta = () => {
      if (runMetaEl) {
        const thinkingLabel = state.thinkingEnabled ? state.thinkingEffort : "off";
        runMetaEl.textContent = "Mode: " + state.mode + " | Model: " + state.model + " | Thinking: " + thinkingLabel;
      }
    };

    const clearForRun = () => {
      if (activityEl) {
        activityEl.innerHTML = "";
      }
      if (logsEl) {
        logsEl.innerHTML = "";
      }
      streamNodes.clear();
      if (tokPromptEl) {
        tokPromptEl.textContent = "0";
      }
      if (tokCompletionEl) {
        tokCompletionEl.textContent = "0";
      }
      if (tokTotalEl) {
        tokTotalEl.textContent = "0";
      }
      if (tokLastEl) {
        tokLastEl.textContent = "-";
      }
      if (statusEl) {
        statusEl.textContent = "Starting...";
      }
    };

    const clearSessionUi = () => {
      if (chatThreadEl) {
        chatThreadEl.innerHTML = "";
      }
      if (chatModalThreadEl) {
        chatModalThreadEl.innerHTML = "";
      }
      if (chatComposerEl) {
        chatComposerEl.value = "";
      }
      closeChatModal();
      clearThinkingState();
      updateThinkingStatus("");
      if (activityEl) {
        activityEl.innerHTML = "";
      }
      if (logsEl) {
        logsEl.innerHTML = "";
      }
      streamNodes.clear();
      if (planEl) {
        planEl.innerHTML = "";
      }
      if (stepStatsEl) {
        stepStatsEl.textContent = "0/0 done";
      }
      if (progressBarEl) {
        progressBarEl.style.width = "0%";
      }
      if (tokPromptEl) {
        tokPromptEl.textContent = "0";
      }
      if (tokCompletionEl) {
        tokCompletionEl.textContent = "0";
      }
      if (tokTotalEl) {
        tokTotalEl.textContent = "0";
      }
      if (tokLastEl) {
        tokLastEl.textContent = "-";
      }
      if (promptEl) {
        promptEl.value = "";
      }
      state.mode = "-";
      state.model = modelSelectEl ? (modelSelectEl.value || "-") : "-";
      refreshRunMeta();
      if (statusEl) {
        statusEl.textContent = "Idle";
      }
    };

    const updatePlanProgress = () => {
      if (!planEl) {
        return;
      }
      const nodes = Array.from(planEl.querySelectorAll("li"));
      const total = nodes.length;
      let done = 0;
      nodes.forEach((node) => {
        if (node.dataset.status === "done") {
          done += 1;
        }
      });

      if (stepStatsEl) {
        stepStatsEl.textContent = done + "/" + total + " done";
      }
      const percent = total > 0 ? Math.round((done * 100) / total) : 0;
      if (progressBarEl) {
        progressBarEl.style.width = String(percent) + "%";
      }
    };

    const renderPlan = (plan) => {
      if (!planEl) {
        return;
      }
      planEl.innerHTML = "";
      if (!plan || !Array.isArray(plan.steps)) {
        updatePlanProgress();
        return;
      }

      for (const step of plan.steps) {
        const li = document.createElement("li");
        li.className = "item";
        li.dataset.stepId = step.id;
        li.dataset.status = step.status || "pending";
        li.textContent = "[" + step.id + "] " + step.title + " (" + li.dataset.status + ")\\n" + (step.details || "");
        planEl.appendChild(li);
      }

      updatePlanProgress();
    };

    const updateStepStatus = (stepId, status) => {
      if (!planEl) {
        return;
      }
      const node = planEl.querySelector('li[data-step-id="' + stepId + '"]');
      if (!node) {
        return;
      }
      node.dataset.status = status;
      const text = node.textContent || "";
      node.textContent = text.replace(/\\((pending|in_progress|done|failed)\\)/, "(" + status + ")");
      updatePlanProgress();
    };

    const normalizeModelItems = (payload) => {
      const out = [];

      if (Array.isArray(payload.items)) {
        for (const item of payload.items) {
          if (typeof item === "string" && item.trim()) {
            out.push(item.trim());
          } else if (item && typeof item === "object" && typeof item.id === "string" && item.id.trim()) {
            out.push(item.id.trim());
          }
        }
      } else if (payload.items && typeof payload.items === "string") {
        try {
          const parsed = JSON.parse(payload.items);
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              if (typeof item === "string" && item.trim()) {
                out.push(item.trim());
              }
            }
          }
        } catch {
          // ignore
        }
      }

      if (out.length === 0 && payload.data && Array.isArray(payload.data)) {
        for (const row of payload.data) {
          if (row && typeof row === "object" && typeof row.id === "string" && row.id.trim()) {
            out.push(row.id.trim());
          }
        }
      }

      return Array.from(new Set(out));
    };

    const updateModels = (payload) => {
      if (!modelSelectEl) {
        appendLog("Model UI error: modelSelect element not found.", "error");
        return;
      }
      if (modelSelectEl.tagName !== "SELECT") {
        appendLog("Model UI error: modelSelect is not a <select> element.", "error");
        return;
      }

      const models = normalizeModelItems(payload);
      postTrace("models_received count=" + String(models.length) + " selected=" + String(payload.selected || "-"));

      const previous = modelSelectEl.value;
      const fragment = document.createDocumentFragment();
      const modelList = models.length > 0 ? models : [""];
      for (const model of modelList) {
        const label = model || "(No models found)";
        const option = document.createElement("option");
        option.value = model;
        option.textContent = label;
        fragment.appendChild(option);
      }
      modelSelectEl.replaceChildren(fragment);

      if (models.length === 0) {
        modelSelectEl.selectedIndex = 0;
      }

      const selected = payload.selected || previous || (models[0] || "");
      if (selected && models.includes(selected)) {
        modelSelectEl.value = selected;
      } else if (models.length > 0) {
        modelSelectEl.selectedIndex = 0;
      }
      if (modelSelectEl.selectedIndex < 0 && modelSelectEl.options.length > 0) {
        modelSelectEl.selectedIndex = 0;
      }
      modelSelectEl.dispatchEvent(new Event("change"));

      state.model = modelSelectEl.value || "-";
      refreshRunMeta();

      if (baseUrlInputEl && payload.baseUrl && typeof payload.baseUrl === "string") {
        baseUrlInputEl.value = payload.baseUrl;
      }

      if (modelInfoEl) {
        if (payload.error) {
          modelInfoEl.textContent = payload.error;
          modelInfoEl.className = "hint error";
        } else {
          modelInfoEl.textContent = payload.info || "";
          modelInfoEl.className = "hint";
        }
      }

      appendLog(
        payload.error
          ? "Model load failed at URL " + (payload.baseUrl || "-")
          : "Model load success: " + String(models.length) + " model(s) from " + (payload.baseUrl || "-"),
        payload.error ? "error" : ""
      );
      postTrace(
        "models_rendered options=" +
          String(modelSelectEl.options.length) +
          " selected=" +
          String(modelSelectEl.value || "-")
      );
    };

    const requestModels = () => {
      try {
        const preferredModel = modelSelectEl ? (modelSelectEl.value || "") : "";
        const baseUrl = String((baseUrlInputEl && baseUrlInputEl.value) || "");
        postTrace("load_models clicked: " + (baseUrl || "(empty)"));
        post({
          type: "load_models",
          preferredModel,
          baseUrl
        });
        appendLog("Requesting models from URL: " + (baseUrl || "(empty -> fallback config)"));
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        post({ type: "client_error", text: "requestModels failed: " + text });
      }
    };

    window.requestModels = requestModels;

    if (planBtn) {
      planBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const prompt = String((promptEl && promptEl.value) || "");
        const model = String((modelSelectEl && modelSelectEl.value) || "");
        const baseUrl = String((baseUrlInputEl && baseUrlInputEl.value) || "");
        const thinkingEnabled = Boolean(thinkingToggleEl && thinkingToggleEl.checked);
        const thinkingEffort = normalizeThinkingEffortUi(thinkingEffortEl ? thinkingEffortEl.value : state.thinkingEffort);
        state.thinkingEnabled = thinkingEnabled;
        state.thinkingEffort = thinkingEffort;
        syncThinkingControls();
        refreshRunMeta();
        postTrace(
          "run clicked: mode=plan model=" +
            (model || "(empty)") +
            " baseUrl=" +
            (baseUrl || "(empty)") +
            " thinking=" +
            (thinkingEnabled ? thinkingEffort : "off")
        );
        clearForRun();
        post({ type: "run", mode: "plan", prompt, model, baseUrl, thinkingEnabled, thinkingEffort });
      });
    }

    if (runBtn) {
      runBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const prompt = String((promptEl && promptEl.value) || "");
        const model = String((modelSelectEl && modelSelectEl.value) || "");
        const baseUrl = String((baseUrlInputEl && baseUrlInputEl.value) || "");
        const thinkingEnabled = Boolean(thinkingToggleEl && thinkingToggleEl.checked);
        const thinkingEffort = normalizeThinkingEffortUi(thinkingEffortEl ? thinkingEffortEl.value : state.thinkingEffort);
        state.thinkingEnabled = thinkingEnabled;
        state.thinkingEffort = thinkingEffort;
        syncThinkingControls();
        refreshRunMeta();
        postTrace(
          "run clicked: mode=agent model=" +
            (model || "(empty)") +
            " baseUrl=" +
            (baseUrl || "(empty)") +
            " thinking=" +
            (thinkingEnabled ? thinkingEffort : "off")
        );
        clearForRun();
        post({ type: "run", mode: "agent", prompt, model, baseUrl, thinkingEnabled, thinkingEffort });
      });
    }

    if (chatBtn) {
      chatBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openChatModal();
        if (chatComposerEl && !String(chatComposerEl.value || "").trim() && promptEl) {
          chatComposerEl.value = String(promptEl.value || "");
        }
      });
    }

    if (closeChatModalBtn) {
      closeChatModalBtn.addEventListener("click", (event) => {
        event.preventDefault();
        closeChatModal();
      });
    }

    if (chatModalEl) {
      chatModalEl.addEventListener("click", (event) => {
        if (event.target === chatModalEl) {
          closeChatModal();
        }
      });
    }

    if (chatSendBtn) {
      chatSendBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (state.running) {
          appendLog("Wait for current run to finish before sending next chat message.", "error");
          return;
        }
        sendChatMessage();
      });
    }

    if (chatComposerEl) {
      chatComposerEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          if (state.running) {
            appendLog("Wait for current run to finish before sending next chat message.", "error");
            return;
          }
          sendChatMessage();
        }
      });
    }

    if (stopBtn) {
      stopBtn.addEventListener("click", () => {
        post({ type: "stop" });
      });
    }

    if (clearSessionBtn) {
      clearSessionBtn.addEventListener("click", () => {
        if (state.running) {
          appendLog("Stop current run before clearing session.", "error");
          return;
        }
        post({ type: "clear_session" });
      });
    }

    if (reloadModelsBtn) {
      const triggerReload = (event) => {
        event.preventDefault();
        event.stopPropagation();
        appendLog("Reload Models clicked.");
        requestModels();
      };
      reloadModelsBtn.addEventListener("click", triggerReload);
      reloadModelsBtn.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          triggerReload(event);
        }
      });
      appendLog("Reload Models action ready.");
      postTrace("reload_models_bound");
    } else {
      appendLog("Reload Models button not found in DOM.", "error");
      post({ type: "client_error", text: "reloadModels button not found in webview" });
    }

    if (thinkingToggleEl) {
      thinkingToggleEl.addEventListener("change", () => {
        state.thinkingEnabled = Boolean(thinkingToggleEl.checked);
        syncThinkingControls();
        refreshRunMeta();
      });
    }

    if (thinkingEffortEl) {
      thinkingEffortEl.addEventListener("change", () => {
        state.thinkingEffort = normalizeThinkingEffortUi(thinkingEffortEl.value);
        syncThinkingControls();
        refreshRunMeta();
      });
    }

    if (baseUrlInputEl) {
      baseUrlInputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          requestModels();
        }
      });
    }

    if (modelSelectEl) {
      modelSelectEl.addEventListener("change", () => {
        state.model = modelSelectEl.value || "-";
        refreshRunMeta();
      });
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      switch (message.type) {
        case "status":
          if (statusEl) {
            statusEl.textContent = message.text;
          }
          break;

        case "run_context":
          state.mode = message.mode;
          state.model = message.model || "-";
          refreshRunMeta();
          break;

        case "running": {
          const disabled = Boolean(message.value);
          state.running = disabled;
          if (planBtn) {
            planBtn.disabled = disabled;
          }
          if (runBtn) {
            runBtn.disabled = disabled;
          }
          if (chatBtn) {
            chatBtn.disabled = disabled;
          }
          if (clearSessionBtn) {
            clearSessionBtn.disabled = disabled;
          }
          if (modelSelectEl) {
            modelSelectEl.disabled = disabled;
          }
          if (chatSendBtn) {
            chatSendBtn.disabled = disabled;
          }
          if (chatComposerEl) {
            chatComposerEl.readOnly = disabled;
          }
          syncThinkingControls();
          break;
        }

        case "models":
          try {
            updateModels(message);
          } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            appendLog("Model UI render failed: " + text, "error");
            post({ type: "client_error", text: "updateModels failed: " + text });
          }
          break;

        case "usage_reset":
          if (tokPromptEl) {
            tokPromptEl.textContent = "0";
          }
          if (tokCompletionEl) {
            tokCompletionEl.textContent = "0";
          }
          if (tokTotalEl) {
            tokTotalEl.textContent = "0";
          }
          if (tokLastEl) {
            tokLastEl.textContent = "-";
          }
          break;

        case "usage": {
          if (tokPromptEl) {
            tokPromptEl.textContent = fmt(message.cumulativePrompt);
          }
          if (tokCompletionEl) {
            tokCompletionEl.textContent = fmt(message.cumulativeCompletion);
          }
          if (tokTotalEl) {
            tokTotalEl.textContent = fmt(message.cumulativeTotal);
          }

          const callText =
            message.phase + " " +
            "p:" + fmt(message.promptTokens) +
            " c:" + fmt(message.completionTokens) +
            " t:" + fmt(message.totalTokens);
          if (tokLastEl) {
            tokLastEl.textContent = callText;
          }
          break;
        }

        case "thinking":
          if (message.clear) {
            clearThinkingState();
            updateThinkingStatus("");
          } else if (typeof message.text === "string" && message.text.trim()) {
            const next = String(message.text).trim();
            ensureThinkingActive();
            thoughtState.text = next;
            updateThinkingStatus(next);
          }
          break;

        case "history":
          renderHistory(message.items);
          break;

        case "chat_message":
          appendChatMessage(message.role, message.text, message.timestamp);
          if (message.role === "assistant") {
            updateThinkingStatus("");
          }
          break;

        case "activity":
          appendActivity(message);
          break;

        case "stream":
          updateStreamLog(message);
          break;

        case "log":
          appendLog(message.text);
          break;

        case "plan":
          renderPlan(message.plan);
          appendLog("Plan: " + (message.plan.summary || ""));
          break;

        case "step":
          updateStepStatus(message.stepId, message.status);
          appendLog("Step " + message.stepId + " -> " + message.status);
          break;

        case "done":
          appendLog(message.text, "done");
          if (statusEl) {
            statusEl.textContent = "Done";
          }
          clearThinkingState();
          updateThinkingStatus("");
          break;

        case "error":
          appendLog(message.text, "error");
          if (statusEl) {
            statusEl.textContent = "Error";
          }
          clearThinkingState();
          updateThinkingStatus("");
          break;

        case "session_cleared":
          clearSessionUi();
          appendLog("Session cleared. New request will start fresh.");
          break;

        default:
          break;
      }
    });

    syncThinkingControls();
    refreshRunMeta();
    appendLog(vscode ? "VS Code bridge ready." : "VS Code webview bridge is unavailable. Reload the window.", vscode ? "" : "error");
    post({ type: "webview_ready" });
    postTrace("boot");
    postTrace("boot-complete");
    requestModels();
    post({ type: "load_history" });
    if (typeof window !== "undefined") {
      window.__localAgentMainReady = true;
    }
    } catch (fatalError) {
      const text =
        fatalError instanceof Error
          ? [fatalError.name, fatalError.message, fatalError.stack || ""].filter(Boolean).join(" | ")
          : String(fatalError);
      postFatalToHost("main_script_fatal: " + text);
    }
  </script>
</body>
</html>`;
}

function createNonce(length = 32): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let output = "";
  for (let i = 0; i < length; i += 1) {
    output += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return output;
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttr(value: string): string {
  return escapeHtmlText(value).replace(/"/g, "&quot;");
}
