// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('node:path');
const { absolutize } = require('../html2md');

/**
 * @typedef {import('../session').Session} Session
 * @typedef {import('../session').SessionState} SessionState
 */

const VIEW_ID = 'codingTest.problem';

/**
 * 사이드바 웹뷰 + (선택적으로) 에디터 옆의 넓은 패널.
 * 상태는 Session이 들고, 여기서는 그리고 메시지를 넘기기만 한다.
 *
 * @implements {vscode.WebviewViewProvider}
 */
class ProblemViewProvider {
  /**
   * @param {vscode.Uri} extensionUri
   * @param {Session} session
   */
  constructor(extensionUri, session) {
    /** @private */
    this._extensionUri = extensionUri;
    /** @private */
    this._session = session;
    /** @private @type {vscode.WebviewView | undefined} */
    this._view = undefined;
    /** @private @type {vscode.WebviewPanel | undefined} */
    this._panel = undefined;
    /** @private @type {vscode.Disposable[]} */
    this._disposables = [];

    this._disposables.push(session.onDidChange(() => this._post()));
  }

  /** 사이드바 뷰가 실제로 보이는 중인지. */
  get isVisible() {
    return Boolean(this._view?.visible);
  }

  /**
   * @param {vscode.WebviewView} view
   * @returns {void}
   */
  resolveWebviewView(view) {
    this._view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
    view.webview.html = this._html(view.webview);
    this._wire(view.webview);
    view.onDidDispose(() => (this._view = undefined), null, this._disposables);
  }

  /**
   * 사이드바가 좁을 때 에디터 옆에 넓게 띄운다.
   * @returns {void}
   */
  openWide() {
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'codingTest.wide',
      '코딩테스트 문제',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, localResourceRoots: [this._extensionUri], retainContextWhenHidden: true }
    );
    panel.webview.html = this._html(panel.webview);
    this._wire(panel.webview);
    panel.onDidDispose(() => (this._panel = undefined));
    this._panel = panel;
  }

  /**
   * 웹뷰에서 오는 메시지를 Session 동작에 연결한다.
   * @private
   * @param {vscode.Webview} webview
   * @returns {void}
   */
  _wire(webview) {
    webview.onDidReceiveMessage(async (msg) => {
      const s = this._session;
      switch (msg?.type) {
        case 'ready':        this._post(); await s.refreshAuth(); break;
        case 'load':         await s.loadProblem(String(msg.url ?? '')); break;
        case 'runLocal':     await s.runLocal(); break;
        case 'submit':       await vscode.commands.executeCommand('codingTest.submit'); break;
        case 'explain':      await s.explainProblem(msg.kind); break;
        case 'addCase':      await s.addCase(draftFrom(msg)); break;
        case 'updateCase':   await s.updateCase(Number(msg.index), draftFrom(msg)); break;
        case 'deleteCase':   await s.deleteCase(Number(msg.index)); break;
        case 'login':        await s.login(); break;
        case 'logout':       await s.logout(); break;
        case 'cancel':       s.cancel(); break;
        case 'openWide':     this.openWide(); break;
        case 'openSolution': await this._openSolution(); break;
        case 'openFolder':   await this._openFolder(); break;
        default: break;
      }
    }, null, this._disposables);
  }

  /**
   * @private
   * @returns {Promise<void>}
   */
  async _openSolution() {
    const dir = this._session.state.dir;
    if (!dir) return;
    const doc = await vscode.workspace.openTextDocument(path.join(dir, 'solution.py'));
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  /**
   * @private
   * @returns {Promise<void>}
   */
  async _openFolder() {
    const dir = this._session.state.dir;
    if (!dir) return;
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.join(dir, 'problem.md')));
  }

  /**
   * 현재 상태를 살아 있는 모든 웹뷰에 보낸다.
   * @private
   * @returns {void}
   */
  _post() {
    const payload = { type: 'state', state: viewModel(this._session.state) };
    this._view?.webview.postMessage(payload);
    this._panel?.webview.postMessage(payload);
  }

  /**
   * @private
   * @param {vscode.Webview} webview
   * @returns {string}
   */
  _html(webview) {
    const nonce = randomNonce();
    const uri = (/** @type {string[]} */ ...p) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, ...p)).toString();

    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} https: data:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('media', 'panel.css')}">
<title>코딩테스트</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${uri('media', 'panel.js')}"></script>
</body>
</html>`;
  }

  dispose() {
    for (const d of this._disposables) d.dispose();
    this._panel?.dispose();
  }
}

/**
 * 웹뷰가 보낸 케이스 편집 메시지를 세션이 쓰는 모양으로 옮긴다.
 * @param {any} msg
 * @returns {{ input?: string, args?: string[], expected: string }}
 */
function draftFrom(msg) {
  return {
    input: typeof msg.input === 'string' ? msg.input : undefined,
    args: Array.isArray(msg.args) ? msg.args.map((/** @type {unknown} */ a) => String(a)) : undefined,
    expected: String(msg.expected ?? ''),
  };
}

/**
 * 웹뷰가 그리기 좋은 형태로 상태를 줄인다.
 * 문제 본문 HTML은 여기서 한 번 걸러 보낸다.
 *
 * @param {SessionState} s
 * @returns {Record<string, unknown>}
 */
function viewModel(s) {
  const p = s.problem;
  return {
    busy: s.busy,
    error: s.error,
    notice: s.notice,
    auth: s.auth,
    dir: s.dir,
    problem: p && {
      title: p.title,
      url: p.url,
      lessonId: p.lessonId,
      type: p.type,
      signature: p.signature,
      descriptionHtml: sanitize(p.descriptionHtml, p.url),
    },
    cases: s.cases,
    results: s.results,
    explanation: s.explanation,
    submitResult: s.submitResult,
  };
}

/**
 * 외부 사이트에서 받은 HTML을 웹뷰에 넣기 전에 걸러낸다.
 * CSP가 이미 스크립트를 막지만, 실행 가능한 것은 애초에 넣지 않는다.
 *
 * @param {string} html
 * @param {string} baseUrl 상대 경로 이미지·링크의 기준
 * @returns {string}
 */
function sanitize(html, baseUrl) {
  return html
    .replace(/<(script|style|iframe|object|embed|form|link|meta|base)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style|iframe|object|embed|form|link|meta|base)\b[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/\s(href|src)\s*=\s*"([^"]*)"/gi, (m, attr, val) => rewriteUrl(m, attr, val, baseUrl))
    .replace(/\s(href|src)\s*=\s*'([^']*)'/gi, (m, attr, val) => rewriteUrl(m, attr, val, baseUrl));
}

/**
 * @param {string} original
 * @param {string} attr
 * @param {string} value
 * @param {string} baseUrl
 * @returns {string}
 */
function rewriteUrl(original, attr, value, baseUrl) {
  const v = value.trim();
  if (/^(javascript|data|vbscript):/i.test(v) && !/^data:image\//i.test(v)) return '';
  return ` ${attr}="${absolutize(v, baseUrl).replace(/"/g, '&quot;')}"`;
}

/** @returns {string} */
function randomNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

module.exports = { ProblemViewProvider, VIEW_ID, sanitize };
