// @ts-check
'use strict';

const vscode = require('vscode');
const { spawn } = require('node:child_process');

/**
 * git 을 얇게 감싼 헬퍼. UI는 모른다 — 문자열을 받고 결과를 돌려줄 뿐이다.
 *
 * 셸을 거치지 않고 `spawn` 으로 직접 부르므로, 커밋 메시지나 경로에 공백·특수문자가
 * 있어도 따옴표 걱정이 없다. 파일을 스테이징할 때는 **정해진 파일만** 명시적으로
 * 넘긴다 — `git add -A` 로 폴더를 통째로 쓸어담지 않는다.
 */

/** 이 기능이 커밋에 담는 파일. 채점 이력·해설은 일부러 뺀다. */
const SOURCE_FILES = ['problem.md', 'solution.py', 'testcases.json'];

/** @returns {string} */
function gitBin() {
  const configured = vscode.workspace.getConfiguration('codingTest').get('gitPath');
  return typeof configured === 'string' && configured.trim() ? configured.trim() : 'git';
}

/**
 * @typedef {Object} GitResult
 * @property {number} code       프로세스 종료 코드 (spawn 실패면 -1)
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} spawnError git 을 실행조차 못했는지
 */

/**
 * git 을 한 번 부른다.
 *
 * @param {string[]} args
 * @param {Object} opts
 * @param {string} opts.cwd
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<GitResult>}
 */
function run(args, { cwd, signal, timeoutMs = 20000 }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(gitBin(), args, { cwd, windowsHide: true });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: e instanceof Error ? e.message : String(e), spawnError: true });
      return;
    }

    let stdout = '';
    let stderr = '';
    let done = false;

    const finish = (/** @type {GitResult} */ r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ code: -1, stdout, stderr: stderr || `git 이 ${timeoutMs / 1000}초 안에 끝나지 않았습니다.`, spawnError: false });
    }, timeoutMs);

    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    child.on('error', (e) => {
      const enoent = /ENOENT/.test(e.message);
      finish({
        code: -1,
        stdout,
        stderr: enoent
          ? 'git 을 찾지 못했습니다. 설치되어 있다면 설정 `codingTest.gitPath` 에 경로를 넣어 주세요.'
          : e.message,
        spawnError: true,
      });
    });
    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr, spawnError: false }));
  });
}

/**
 * 주어진 경로가 속한 git 저장소의 최상위 폴더. 저장소가 아니면 null.
 * @param {string} cwd
 * @returns {Promise<string | null>}
 */
async function repoRoot(cwd) {
  const r = await run(['rev-parse', '--show-toplevel'], { cwd });
  if (r.code !== 0) return null;
  return r.stdout.trim() || null;
}

/**
 * @param {string} cwd
 * @returns {Promise<void>}
 */
async function init(cwd) {
  const r = await run(['init', '-b', 'main'], { cwd });
  if (r.code !== 0) throw new Error(gitError('저장소를 만들지 못했습니다', r));
}

/**
 * @param {string} cwd
 * @returns {Promise<string[]>}
 */
async function remotes(cwd) {
  const r = await run(['remote'], { cwd });
  if (r.code !== 0) return [];
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/**
 * @param {string} cwd
 * @param {string} name
 * @returns {Promise<string | null>}
 */
async function remoteUrl(cwd, name) {
  const r = await run(['remote', 'get-url', name], { cwd });
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * @param {string} cwd
 * @param {string} name
 * @param {string} url
 * @returns {Promise<void>}
 */
async function addRemote(cwd, name, url) {
  const r = await run(['remote', 'add', name, url], { cwd });
  if (r.code !== 0) throw new Error(gitError('원격을 추가하지 못했습니다', r));
}

/**
 * @param {string} cwd
 * @returns {Promise<string>}
 */
async function currentBranch(cwd) {
  const r = await run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  const name = r.stdout.trim();
  // 커밋이 하나도 없으면 HEAD 가 없어서 이름이 안 나온다. 기본 브랜치로 본다.
  return name && name !== 'HEAD' ? name : 'main';
}

/**
 * 정해진 파일들만 스테이징한다.
 * @param {string} cwd
 * @param {string[]} absPaths 스테이징할 파일의 절대 경로
 * @returns {Promise<void>}
 */
async function addPaths(cwd, absPaths) {
  if (absPaths.length === 0) return;
  const r = await run(['add', '--', ...absPaths], { cwd });
  if (r.code !== 0) throw new Error(gitError('파일을 스테이징하지 못했습니다', r));
}

/**
 * 스테이징된 변경이 있는지.
 * @param {string} cwd
 * @returns {Promise<boolean>}
 */
async function hasStaged(cwd) {
  // diff --cached --quiet 는 변경이 없으면 0, 있으면 1 로 끝난다.
  const r = await run(['diff', '--cached', '--quiet'], { cwd });
  return r.code === 1;
}

/**
 * @param {string} cwd
 * @param {string} message
 * @returns {Promise<void>}
 */
async function commit(cwd, message) {
  const r = await run(['commit', '-m', message], { cwd });
  if (r.code !== 0) throw new Error(gitError('커밋에 실패했습니다', r));
}

/**
 * @param {string} cwd
 * @returns {Promise<string>} 방금 커밋의 짧은 해시
 */
async function shortHead(cwd) {
  const r = await run(['rev-parse', '--short', 'HEAD'], { cwd });
  return r.stdout.trim();
}

/**
 * @param {string} cwd
 * @param {string[]} args push 인자 (예: ['-u', 'origin', 'main'])
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
async function push(cwd, args, signal) {
  // 자격증명 창(Git Credential Manager)이 뜰 수 있어 넉넉하게 준다.
  const r = await run(['push', ...args], { cwd, signal, timeoutMs: 180000 });
  if (r.code !== 0) throw new Error(gitError('push 에 실패했습니다', r));
}

/**
 * @param {string} cwd
 * @param {string} branch
 * @returns {Promise<number | null>} 아직 push 안 된 커밋 수. 상류가 없으면 null.
 */
async function unpushedCount(cwd, branch) {
  const r = await run(['rev-list', '--count', `@{upstream}..${branch}`], { cwd });
  if (r.code !== 0) return null; // 상류가 설정되지 않음
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {string} label
 * @param {GitResult} r
 * @returns {string}
 */
function gitError(label, r) {
  const detail = (r.stderr || r.stdout).trim();
  return detail ? `${label}: ${detail}` : label;
}

module.exports = {
  SOURCE_FILES,
  run,
  repoRoot,
  init,
  remotes,
  remoteUrl,
  addRemote,
  currentBranch,
  addPaths,
  hasStaged,
  commit,
  shortHead,
  push,
  unpushedCount,
};
