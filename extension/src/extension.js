// @ts-check
'use strict';

const vscode = require('vscode');
const { Auth } = require('./auth');
const { BrowserLogin } = require('./browserLogin');
const { Session } = require('./session');
const { ProblemViewProvider, VIEW_ID } = require('./panel/provider');

/**
 * @param {vscode.ExtensionContext} context
 * @returns {void}
 */
function activate(context) {
  const auth = new Auth(context.secrets);
  const browserLogin = new BrowserLogin(
    context.globalStorageUri.fsPath,
    () => String(vscode.workspace.getConfiguration('codingTest').get('browserPath') || '')
  );
  const session = new Session(auth, browserLogin);
  const provider = new ProblemViewProvider(context.extensionUri, session);

  context.subscriptions.push(
    session,
    provider,

    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand('codingTest.toggle', async () => {
      if (provider.isVisible) {
        await vscode.commands.executeCommand('workbench.action.closeSidebar');
      } else {
        await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      }
    }),

    vscode.commands.registerCommand('codingTest.loadProblem', async () => {
      const url = await vscode.window.showInputBox({
        title: '프로그래머스 문제 불러오기',
        prompt: '문제 URL 또는 문제 번호',
        placeHolder: 'https://school.programmers.co.kr/learn/courses/30/lessons/181950',
        ignoreFocusOut: true,
      });
      if (!url) return;
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      await session.loadProblem(url);
    }),

    vscode.commands.registerCommand('codingTest.runLocal', () => session.runLocal()),
    vscode.commands.registerCommand('codingTest.submit', () => session.submit()),
    vscode.commands.registerCommand('codingTest.login', () => session.login()),
    vscode.commands.registerCommand('codingTest.logout', () => session.logout()),
    // 이전 버전의 명령 ID는 사용자 단축키 호환을 위해 등록만 유지한다.
    vscode.commands.registerCommand('codingTest.setCookie', () => session.login()),
    vscode.commands.registerCommand('codingTest.clearCookie', () => session.logout()),
    vscode.commands.registerCommand('codingTest.openWide', () => provider.openWide())
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
