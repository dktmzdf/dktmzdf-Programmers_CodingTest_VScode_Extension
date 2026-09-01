// @ts-check
'use strict';

const vscode = require('vscode');
const { spawn } = require('node:child_process');
const path = require('node:path');

/** 함수형 문제를 돌릴 때 쓰는 파이썬 실행기. solution.py 는 건드리지 않는다. */
const HARNESS = path.join(__dirname, '..', 'python', 'harness.py');

/**
 * @typedef {import('./programmers/parser').TestCase} TestCase
 */

/**
 * @typedef {Object} CaseResult
 * @property {string} name
 * @property {'pass' | 'fail' | 'error' | 'timeout'} status
 * @property {string} input     사람이 읽을 입력 표현 (함수형은 `이름 = 값` 나열)
 * @property {string} expected
 * @property {string} actual
 * @property {string} stdout    사용자가 찍은 print 출력 (함수형에서만 채워진다)
 * @property {string} stderr
 * @property {number} ms
 */

/**
 * @typedef {Object} RawRun
 * @property {string} stdout
 * @property {string} stderr
 * @property {number | null} code
 * @property {boolean} timedOut
 * @property {string | null} spawnError
 * @property {number} ms
 */

/**
 * 쓸 파이썬 인터프리터를 고른다.
 * 설정 → Python 확장이 선택한 인터프리터 → `python` 순.
 * @returns {Promise<string>}
 */
async function resolvePython() {
  const configured = vscode.workspace.getConfiguration('codingTest').get('pythonPath');
  if (typeof configured === 'string' && configured.trim()) return configured.trim();

  try {
    const ext = vscode.extensions.getExtension('ms-python.python');
    if (ext) {
      if (!ext.isActive) await ext.activate();
      const cmd = ext.exports?.settings?.getExecutionDetails?.()?.execCommand;
      if (Array.isArray(cmd) && cmd.length > 0 && typeof cmd[0] === 'string') return cmd[0];
    }
  } catch {
    // Python 확장이 없거나 API가 바뀌었을 뿐이다. 기본값으로 넘어간다.
  }

  return 'python';
}

/**
 * 파이썬을 한 번 돌리고 표준출력·표준에러를 모은다.
 * 두 문제 형식이 공유하는 부분 — 타임아웃·취소·인코딩 처리가 여기 모여 있다.
 *
 * @param {Object} opts
 * @param {string} opts.python
 * @param {string[]} opts.args
 * @param {string} opts.cwd
 * @param {string} opts.stdin
 * @param {number} opts.timeoutMs
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<RawRun>}
 */
function spawnCapture({ python, args, cwd, stdin, timeoutMs, signal }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(python, args, {
      cwd,
      env: {
        ...process.env,
        // 한글 출력이 cp949로 깨지지 않게 못 박는다.
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
        // 함수형 하네스가 solution.py 를 import 하면서 문제 폴더에 __pycache__ 를
        // 남기지 않게 한다. 숙제 폴더에는 결과물만 있어야 한다.
        PYTHONDONTWRITEBYTECODE: '1',
      },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;

    const settle = (/** @type {Partial<RawRun>} */ patch) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        stdout,
        stderr,
        code: null,
        timedOut,
        spawnError: null,
        ms: Date.now() - started,
        ...patch,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    child.on('error', (err) => settle({ spawnError: err.message }));
    child.on('close', (code) => settle({ code }));

    // 입력이 없어도 stdin은 닫아 줘야 input() 이 EOF로 끝난다.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

/**
 * 표준입출력형: `python solution.py` 를 돌리고 표준출력을 기대값과 비교한다.
 *
 * @param {Object} opts
 * @param {string} opts.python
 * @param {string} opts.solutionPath
 * @param {TestCase} opts.testCase
 * @param {number} opts.timeoutMs
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<CaseResult>}
 */
async function runStdioCase({ python, solutionPath, testCase, timeoutMs, signal }) {
  const input = testCase.input ?? '';
  const run = await spawnCapture({
    python,
    args: [path.basename(solutionPath)],
    cwd: path.dirname(solutionPath),
    stdin: input ? input.replace(/\n*$/, '\n') : '',
    timeoutMs,
    signal,
  });

  /** @type {CaseResult['status']} */
  let status;
  if (run.timedOut) status = 'timeout';
  else if (run.spawnError || run.code !== 0) status = 'error';
  else status = normalize(run.stdout) === normalize(testCase.expected) ? 'pass' : 'fail';

  return {
    name: testCase.name,
    status,
    input,
    expected: testCase.expected,
    actual: run.stdout.replace(/\r\n/g, '\n'),
    stdout: '',
    stderr: describeFailure(run, python),
    ms: run.ms,
  };
}

/**
 * 함수형: 하네스를 통해 `solution(*args)` 를 부르고 반환값을 비교한다.
 *
 * @param {Object} opts
 * @param {string} opts.python
 * @param {string} opts.solutionPath
 * @param {TestCase} opts.testCase
 * @param {string[]} opts.signature
 * @param {number} opts.timeoutMs
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<CaseResult>}
 */
async function runFunctionCase({ python, solutionPath, testCase, signature, timeoutMs, signal }) {
  const payload = JSON.stringify({
    path: solutionPath,
    args: testCase.args ?? [],
    expected: testCase.expected,
  });

  const run = await spawnCapture({
    python,
    args: [HARNESS],
    cwd: path.dirname(solutionPath),
    stdin: payload,
    timeoutMs,
    signal,
  });

  const base = {
    name: testCase.name,
    input: describeArgs(testCase, signature),
    expected: testCase.expected,
    ms: run.ms,
  };

  if (run.timedOut) {
    return { ...base, status: 'timeout', actual: '', stdout: '', stderr: describeFailure(run, python) };
  }
  if (run.spawnError) {
    return { ...base, status: 'error', actual: '', stdout: '', stderr: describeFailure(run, python) };
  }

  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    // 하네스가 JSON을 못 뱉었다 — 파이썬 자체가 죽은 경우다.
    return {
      ...base,
      status: 'error',
      actual: '',
      stdout: '',
      stderr: (run.stderr || run.stdout || '실행기가 결과를 돌려주지 않았습니다.').trim(),
    };
  }

  return {
    ...base,
    status: parsed.error ? 'error' : parsed.passed ? 'pass' : 'fail',
    // 기대값도 하네스가 해석한 파이썬 표현으로 바꿔 실제값과 나란히 비교되게 한다.
    expected: parsed.expected ?? testCase.expected,
    actual: parsed.actual ?? '',
    stdout: parsed.stdout ?? '',
    stderr: [parsed.error, run.stderr].filter(Boolean).join('\n').trim(),
  };
}

/**
 * 케이스 전부를 차례로 돌린다.
 *
 * @param {Object} opts
 * @param {string} opts.solutionPath
 * @param {TestCase[]} opts.cases
 * @param {'stdio' | 'function' | 'unknown'} opts.type
 * @param {string[]} [opts.signature]
 * @param {AbortSignal} [opts.signal]
 * @param {(r: CaseResult, i: number) => void} [opts.onResult] 하나 끝날 때마다 알린다
 * @returns {Promise<CaseResult[]>}
 */
async function runAll({ solutionPath, cases, type, signature = [], signal, onResult }) {
  const python = await resolvePython();
  const timeoutMs = Number(
    vscode.workspace.getConfiguration('codingTest').get('timeoutMs') ?? 5000
  );

  /** @type {CaseResult[]} */
  const results = [];
  for (let i = 0; i < cases.length; i++) {
    if (signal?.aborted) break;
    const testCase = cases[i];
    const r =
      type === 'function'
        ? await runFunctionCase({ python, solutionPath, testCase, signature, timeoutMs, signal })
        : await runStdioCase({ python, solutionPath, testCase, timeoutMs, signal });
    results.push(r);
    onResult?.(r, i);
  }
  return results;
}

/**
 * 함수형 케이스의 인자를 사람이 읽게 편다.
 * @param {TestCase} testCase
 * @param {string[]} signature
 * @returns {string}
 */
function describeArgs(testCase, signature) {
  const args = testCase.args ?? [];
  return args.map((a, i) => `${signature[i] ?? `arg${i + 1}`} = ${a}`).join('\n');
}

/**
 * 실행 자체가 잘못됐을 때 보여 줄 설명.
 * @param {RawRun} run
 * @param {string} python
 * @returns {string}
 */
function describeFailure(run, python) {
  if (run.spawnError) return `파이썬을 실행하지 못했습니다 (${python}): ${run.spawnError}`;
  if (run.timedOut) return '제한 시간 안에 끝나지 않아 중단했습니다.';
  return run.stderr;
}

/**
 * 비교 전 출력 정규화: CRLF 통일, 줄 끝 공백 제거, 마지막 빈 줄 무시.
 * @param {string} s
 * @returns {string}
 */
function normalize(s) {
  return s
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

module.exports = { resolvePython, runAll, describeArgs, normalize, HARNESS };
