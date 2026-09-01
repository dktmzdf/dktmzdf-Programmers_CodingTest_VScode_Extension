// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * @typedef {import('./programmers/parser').Problem} Problem
 * @typedef {import('./programmers/parser').TestCase} TestCase
 */

/**
 * `testcases.json` 의 내용.
 *
 * `type` 이 두 스키마를 가른다:
 * - `stdio`    — 각 케이스에 `input`
 * - `function` — 각 케이스에 `args`, 그리고 파일 전체에 `signature`
 *
 * @typedef {Object} TestcaseFile
 * @property {number} lessonId
 * @property {string} title
 * @property {'stdio' | 'function'} type
 * @property {string[]} [signature]
 * @property {TestCase[]} cases
 */

/**
 * 문제 폴더들이 놓일 최상위 경로.
 * 설정이 비어 있으면 열려 있는 워크스페이스의 `problems/` 를 쓴다.
 * @returns {string}
 */
function resolveRoot() {
  const configured = vscode.workspace.getConfiguration('codingTest').get('problemsRoot');
  if (typeof configured === 'string' && configured.trim()) {
    return path.resolve(configured.trim());
  }

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error(
      '문제를 저장할 위치가 없습니다. 폴더를 하나 열거나, ' +
        '설정에서 `codingTest.problemsRoot` 를 지정해 주세요.'
    );
  }
  return path.join(folder.uri.fsPath, 'problems');
}

/**
 * 제목을 폴더 이름으로 쓸 수 있게 다듬는다. (Windows 금지 문자 제거)
 * @param {string} title
 * @returns {string}
 */
function slugify(title) {
  const s = title
    .replace(/[<>:"/\\|?*]/g, '')      // Windows 금지 문자
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return (s || 'problem').slice(0, 60);
}

/**
 * @param {Problem} problem
 * @returns {string}
 */
function dirFor(problem) {
  return path.join(resolveRoot(), `${problem.lessonId}-${slugify(problem.title)}`);
}

/**
 * 문제 폴더를 만들고 problem.md / solution.py / testcases.json 을 채운다.
 *
 * - `problem.md` 는 항상 최신 내용으로 덮어쓴다.
 * - `solution.py` 는 **이미 있으면 건드리지 않는다** (내가 쓴 코드가 날아가면 안 된다).
 * - `testcases.json` 은 공식 예제만 갱신하고 내가 추가한 케이스는 보존한다.
 *
 * @param {Problem} problem
 * @returns {Promise<{ dir: string, solutionPath: string, solutionCreated: boolean, cases: TestCase[] }>}
 */
async function saveProblem(problem) {
  const dir = dirFor(problem);
  await fs.mkdir(dir, { recursive: true });

  await write(path.join(dir, 'problem.md'), renderProblemMd(problem));

  const solutionPath = path.join(dir, 'solution.py');
  const solutionCreated = !(await exists(solutionPath));
  if (solutionCreated) {
    await write(solutionPath, (problem.initialCode || '') + '\n');
  }

  const type = problem.type === 'function' ? 'function' : 'stdio';
  const existing = await loadTestcases(dir);
  const cases = mergeCases(problem.cases, existing?.cases ?? [], type);

  await saveTestcases(dir, {
    lessonId: problem.lessonId,
    title: problem.title,
    type,
    ...(type === 'function' ? { signature: problem.signature } : {}),
    cases,
  });

  return { dir, solutionPath, solutionCreated, cases };
}

/**
 * 공식 예제는 새로 받은 것으로 갈아끼우고, 내가 추가한 케이스는 뒤에 그대로 붙인다.
 *
 * 형식이 바뀐 문제라면(사이트 개편 등) 예전 스키마로 저장된 내 케이스는 실행할 수
 * 없으므로 걸러 낸다 — 조용히 깨진 케이스를 남기는 것보다 낫다.
 *
 * @param {TestCase[]} official
 * @param {TestCase[]} existing
 * @param {'stdio' | 'function'} type
 * @returns {TestCase[]}
 */
function mergeCases(official, existing, type) {
  const fits = (/** @type {TestCase} */ c) =>
    type === 'function' ? Array.isArray(c.args) : typeof c.input === 'string';

  const mine = existing.filter((c) => c.source === 'user' && fits(c));
  return [...official, ...mine];
}

/**
 * @param {Problem} problem
 * @returns {string}
 */
function renderProblemMd(problem) {
  return [
    `# ${problem.title}`,
    '',
    `- 출처: ${problem.url}`,
    `- lesson id: ${problem.lessonId}`,
    `- 저장: ${stamp()}`,
    '',
    '---',
    '',
    problem.descriptionMd,
    '',
  ].join('\n');
}

/**
 * @param {string} dir
 * @returns {Promise<TestcaseFile | null>}
 */
async function loadTestcases(dir) {
  try {
    const raw = await fs.readFile(path.join(dir, 'testcases.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.cases)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @param {string} dir
 * @param {TestcaseFile} data
 * @returns {Promise<void>}
 */
async function saveTestcases(dir, data) {
  await write(path.join(dir, 'testcases.json'), JSON.stringify(data, null, 2) + '\n');
}

/**
 * @param {string} dir
 * @returns {Promise<string>}
 */
async function readSolution(dir) {
  return await fs.readFile(path.join(dir, 'solution.py'), 'utf8');
}

/**
 * 결과·해설 이력을 파일 끝에 덧붙인다.
 * @param {string} dir
 * @param {'result.md' | 'explanation.md'} file
 * @param {string} heading
 * @param {string} body
 * @returns {Promise<string>} 기록한 파일 경로
 */
async function appendSection(dir, file, heading, body) {
  const target = path.join(dir, file);
  const head = (await exists(target)) ? '' : `# ${file === 'result.md' ? '채점 결과 이력' : '해설 이력'}\n\n`;
  await fs.appendFile(target, `${head}## [${stamp()}] ${heading}\n\n${body.trim()}\n\n`, 'utf8');
  return target;
}

/**
 * @param {string} p
 * @param {string} content
 * @returns {Promise<void>}
 */
async function write(p, content) {
  await fs.writeFile(p, content, 'utf8');
}

/**
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** @returns {string} `2026-09-01 14:23:05` */
function stamp() {
  const d = new Date();
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

module.exports = {
  resolveRoot,
  slugify,
  dirFor,
  saveProblem,
  mergeCases,
  loadTestcases,
  saveTestcases,
  readSolution,
  appendSection,
  exists,
  stamp,
};
