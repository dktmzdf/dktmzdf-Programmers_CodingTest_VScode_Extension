// @ts-check
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const LOGIN_URL =
  'https://school.programmers.co.kr/account/sign_in?referer=%2Flearn%2Fchallenges';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** @typedef {{ name: string, value: string, domain?: string }} CdpCookie */

/** 설치된 브라우저와 전용 프로필을 이용해 로그인 쿠키를 얻는다. */
class BrowserLogin {
  /**
   * @param {string} storageDir ExtensionContext.globalStorageUri.fsPath
   * @param {() => string} configuredPath
   */
  constructor(storageDir, configuredPath) {
    this._storageDir = path.resolve(storageDir);
    this._profileDir = path.join(this._storageDir, 'browser-profile');
    this._configuredPath = configuredPath;
    /** @private @type {import('node:child_process').ChildProcess | null} */
    this._child = null;
    /** @private @type {CdpClient | null} */
    this._cdp = null;
  }

  /**
   * @param {(cookie: string) => Promise<boolean>} validate
   * @param {AbortSignal} signal
   * @returns {Promise<string>}
   */
  async login(validate, signal) {
    if (this._child) throw new Error('로그인 브라우저가 이미 열려 있습니다.');

    const browser = await findBrowser(this._configuredPath());
    if (!browser) {
      throw new Error(
        'Chrome 또는 Edge를 찾지 못했습니다. 설정 `codingTest.browserPath`에 실행 파일 경로를 지정해 주세요.'
      );
    }

    await fs.mkdir(this._profileDir, { recursive: true });
    // 이전 비정상 종료가 남긴 포트 파일을 새 실행의 것으로 오해하지 않는다.
    await fs.rm(path.join(this._profileDir, 'DevToolsActivePort'), { force: true });

    const child = spawn(
      browser,
      [
        `--user-data-dir=${this._profileDir}`,
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        '--new-window',
        LOGIN_URL,
      ],
      { windowsHide: false, stdio: 'ignore' }
    );
    this._child = child;

    const onAbort = () => this._stopBrowser();
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      const endpoint = await waitForEndpoint(this._profileDir, child, signal);
      const cdp = await CdpClient.connect(endpoint, signal);
      this._cdp = cdp;

      const deadline = Date.now() + LOGIN_TIMEOUT_MS;
      let lastChecked = '';
      while (Date.now() < deadline) {
        if (signal.aborted) throw new Error('로그인을 취소했습니다.');
        if (child.exitCode !== null) throw new Error('로그인 브라우저가 닫혔습니다.');

        const response = await cdp.call('Storage.getCookies');
        const header = cookieHeader(response?.cookies ?? []);
        if (header && header !== lastChecked) {
          lastChecked = header;
          if (await validate(header)) return header;
        }
        await delay(1000, signal);
      }
      throw new Error('5분 안에 로그인을 확인하지 못했습니다. 다시 시도해 주세요.');
    } finally {
      signal.removeEventListener('abort', onAbort);
      await this._stopBrowser();
    }
  }

  /** 브라우저를 닫고 전용 프로필까지 지운다. */
  async logout() {
    await this._stopBrowser();
    const target = path.resolve(this._profileDir);
    const expected = path.resolve(this._storageDir, 'browser-profile');
    if (target !== expected || path.dirname(target) !== this._storageDir) {
      throw new Error('전용 브라우저 프로필 경로가 올바르지 않아 삭제하지 않았습니다.');
    }
    await fs.rm(target, { recursive: true, force: true });
  }

  async _stopBrowser() {
    const cdp = this._cdp;
    const child = this._child;
    this._cdp = null;
    this._child = null;
    if (cdp) {
      await cdp.call('Browser.close').catch(() => {});
      cdp.close();
    }
    if (child && child.exitCode === null) child.kill();
  }

  dispose() {
    void this._stopBrowser();
  }
}

/**
 * @param {string} configured
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string | null>}
 */
async function findBrowser(configured, env = process.env) {
  const candidates = browserCandidates(configured, env);
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch { /* 다음 후보 */ }
  }
  return null;
}

/** @param {string} configured @param {NodeJS.ProcessEnv} env */
function browserCandidates(configured, env) {
  const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
  const out = configured.trim() ? [path.resolve(configured.trim())] : [];
  for (const root of roots) {
    out.push(path.join(String(root), 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  for (const root of roots) {
    out.push(path.join(String(root), 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  return [...new Set(out)];
}

/** @param {CdpCookie[]} cookies */
function cookieHeader(cookies) {
  return cookies
    .filter((c) => isProgrammersDomain(c.domain ?? ''))
    .filter((c) => c.name && !/[;=\r\n]/.test(c.name) && !/[;\r\n]/.test(c.value))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/** @param {string} domain */
function isProgrammersDomain(domain) {
  const d = domain.toLowerCase().replace(/^\./, '');
  return d === 'programmers.co.kr' || d.endsWith('.programmers.co.kr');
}

/** @param {string} profileDir @param {import('node:child_process').ChildProcess} child @param {AbortSignal} signal */
async function waitForEndpoint(profileDir, child, signal) {
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + 15000;
  /** @type {Error | null} */
  let spawnError = null;
  const onError = (/** @type {Error} */ e) => { spawnError = e; };
  child.once('error', onError);
  try {
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error('로그인을 취소했습니다.');
      if (spawnError) throw new Error(`로그인 브라우저를 실행하지 못했습니다: ${spawnError.message}`);
      if (child.exitCode !== null) throw new Error('로그인 브라우저를 실행하지 못했습니다.');
      try {
        const [port, socketPath] = (await fs.readFile(portFile, 'utf8')).trim().split(/\r?\n/);
        if (/^\d+$/.test(port) && socketPath) return `ws://127.0.0.1:${port}${socketPath}`;
      } catch { /* 브라우저가 파일을 만들 때까지 기다린다 */ }
      await delay(100, signal);
    }
  } finally {
    child.removeListener('error', onError);
  }
  throw new Error('로그인 브라우저의 자동화 포트에 연결하지 못했습니다.');
}

class CdpClient {
  /** @param {WebSocket} socket */
  constructor(socket) {
    this._socket = socket;
    this._nextId = 1;
    /** @type {Map<number, {resolve: (v:any)=>void, reject:(e:Error)=>void}>} */
    this._pending = new Map();
    socket.addEventListener('message', (ev) => this._message(String(ev.data)));
    socket.addEventListener('close', () => this._failAll(new Error('로그인 브라우저 연결이 끊겼습니다.')));
  }

  /** @param {string} endpoint @param {AbortSignal} signal */
  static connect(endpoint, signal) {
    return new Promise((resolve, reject) => {
      if (typeof WebSocket === 'undefined') {
        reject(new Error('현재 VS Code에서는 브라우저 자동 로그인을 지원하지 않습니다. VS Code를 업데이트해 주세요.'));
        return;
      }
      const socket = new WebSocket(endpoint);
      const onAbort = () => { socket.close(); reject(new Error('로그인을 취소했습니다.')); };
      signal.addEventListener('abort', onAbort, { once: true });
      socket.addEventListener('open', () => {
        signal.removeEventListener('abort', onAbort);
        resolve(new CdpClient(socket));
      }, { once: true });
      socket.addEventListener('error', () => {
        signal.removeEventListener('abort', onAbort);
        reject(new Error('로그인 브라우저에 연결하지 못했습니다.'));
      }, { once: true });
    });
  }

  /** @param {string} method @param {Record<string, unknown>} [params] */
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      this._pending.set(id, { resolve, reject });
      try { this._socket.send(JSON.stringify({ id, method, params })); }
      catch (e) { this._pending.delete(id); reject(e instanceof Error ? e : new Error(String(e))); }
    });
  }

  /** @param {string} raw */
  _message(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg.id) return;
    const pending = this._pending.get(msg.id);
    if (!pending) return;
    this._pending.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error.message || '브라우저 자동화 요청이 실패했습니다.'));
    else pending.resolve(msg.result);
  }

  /** @param {Error} error */
  _failAll(error) {
    for (const pending of this._pending.values()) pending.reject(error);
    this._pending.clear();
  }

  close() { try { this._socket.close(); } catch { /* 이미 닫힘 */ } }
}

/** @param {number} ms @param {AbortSignal} signal */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('로그인을 취소했습니다.'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(undefined);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

module.exports = {
  BrowserLogin,
  LOGIN_URL,
  browserCandidates,
  cookieHeader,
  isProgrammersDomain,
};
