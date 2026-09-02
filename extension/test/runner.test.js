// @ts-check
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { install: installVscodeStub, config } = require('./_vscode-stub');

const FIXTURES = path.join(__dirname, 'fixtures');
const WORK = path.join(os.tmpdir(), 'coding-test-agent-test');

/** @returns {boolean} 파이썬이 실제로 있는지 */
function pythonAvailable() {
  try {
    return spawnSync('python', ['--version'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}

/**
 * @param {string} name
 * @param {string} code
 * @returns {string} solution.py 경로
 */
function makeSolution(name, code) {
  const dir = path.join(WORK, name);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'solution.py');
  fs.writeFileSync(p, code, 'utf8');
  return p;
}

/**
 * @param {import('./assert').Suite} t
 */
module.exports = async function runnerTests(t) {
  t.section('로컬 실행기');

  if (!pythonAvailable()) {
    t.skip('로컬 실행기 전체', 'python 을 PATH 에서 찾지 못했다');
    return;
  }

  installVscodeStub();
  const { runAll } = require('../src/runner');
  const { parseLessonUrl, parseLessonPage } = require('../src/programmers/parser');

  /** @param {number} id */
  const problemOf = (id) => {
    const { url } = parseLessonUrl(String(id));
    return parseLessonPage(fs.readFileSync(path.join(FIXTURES, id + '.html'), 'utf8'), url);
  };

  fs.rmSync(WORK, { recursive: true, force: true });

  const fnProblem = problemOf(181943);
  const stdioProblem = problemOf(181950);

  /**
   * @param {string} name
   * @param {import('../src/programmers/parser').Problem} problem
   * @param {string} code
   * @param {number} [caseCount] 앞에서 몇 개만 돌릴지
   */
  const run = async (name, problem, code, caseCount) => {
    const solutionPath = makeSolution(name, code);
    const results = await runAll({
      solutionPath,
      cases: problem.cases.slice(0, caseCount ?? problem.cases.length),
      type: problem.type,
      signature: problem.signature,
    });
    return { results, dir: path.dirname(solutionPath) };
  };

  const SOLVED =
    'def solution(my_string, overwrite_string, s):\n' +
    '    return my_string[:s] + overwrite_string + my_string[s + len(overwrite_string):]\n';

  // ---- 함수형 ----
  {
    const { results, dir } = await run('fn-ok', fnProblem, SOLVED);
    t.eq('함수형 정답 — 전부 통과', results.map((r) => r.status), ['pass', 'pass']);

    // __pycache__ 오염 회귀 테스트: 하네스가 solution.py 를 import 해도
    // 문제 폴더에 바이트코드를 남기면 안 된다.
    t.ok('__pycache__ 를 남기지 않는다', !fs.existsSync(path.join(dir, '__pycache__')));
  }

  {
    const code = SOLVED.replace('    return', '    print("디버그", s)\n    return');
    const { results } = await run('fn-print', fnProblem, code);
    t.eq('print 이 있어도 통과', results.map((r) => r.status), ['pass', 'pass']);
    t.ok('print 출력을 따로 담는다', results[0].stdout.includes('디버그'), results[0].stdout);
    t.ok('print 가 반환값에 섞이지 않는다', !results[0].actual.includes('디버그'), results[0].actual);
  }

  {
    const { results } = await run('fn-wrong', fnProblem,
      'def solution(my_string, overwrite_string, s):\n    return my_string\n');
    t.eq('함수형 오답 — 실패로 잡는다', results.map((r) => r.status), ['fail', 'fail']);
    // 기대값도 파이썬 표현으로 바꿔 실제값과 표기가 맞아야 비교가 된다.
    t.eq('기대값을 파이썬 표현으로', results[0].expected, "'HelloWorld'");
    t.eq('실제값도 파이썬 표현으로', results[0].actual, "'He11oWor1d'");
    t.ok('인자를 이름과 함께 보여준다', results[0].input.includes('my_string = '), results[0].input);
  }

  {
    const { results } = await run('fn-boom', fnProblem,
      'def solution(my_string, overwrite_string, s):\n    return 1 / 0\n');
    t.eq('예외는 error 로', results.map((r) => r.status), ['error', 'error']);
    t.ok('트레이스백을 그대로 보여준다',
      results[0].stderr.includes('ZeroDivisionError'), results[0].stderr);
  }

  {
    config.timeoutMs = 1500;
    const { results } = await run('fn-loop', fnProblem,
      'def solution(my_string, overwrite_string, s):\n    while True:\n        pass\n', 1);
    config.timeoutMs = 5000;
    t.eq('무한루프는 timeout 으로', results.map((r) => r.status), ['timeout']);
  }

  // ---- 표준입출력형 (회귀) ----
  {
    const { results } = await run('io-ok', stdioProblem,
      "str, n = input().strip().split(' ')\nn = int(n)\nprint(str * n)\n");
    t.eq('stdio 정답', results.map((r) => r.status), ['pass']);
  }

  {
    const { results } = await run('io-wrong', stdioProblem,
      "str, n = input().strip().split(' ')\nprint(str)\n");
    t.eq('stdio 오답', results.map((r) => r.status), ['fail']);
    t.eq('stdio 는 표준출력을 그대로 비교', results[0].actual, 'string\n');
  }

  // ---- 인터프리터가 없을 때 죽지 않는지 ----
  {
    config.pythonPath = 'definitely-not-a-real-python';
    const { results } = await run('io-nopython', stdioProblem, 'print(1)\n');
    config.pythonPath = '';
    t.eq('없는 인터프리터 → error', results.map((r) => r.status), ['error']);
    t.ok('무엇이 문제인지 알려준다',
      results[0].stderr.includes('파이썬을 실행하지 못했습니다'), results[0].stderr);
  }

  fs.rmSync(WORK, { recursive: true, force: true });
};
