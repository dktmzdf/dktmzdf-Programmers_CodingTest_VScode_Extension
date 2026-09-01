// @ts-check
'use strict';

const vscode = require('vscode');
const { spawn } = require('node:child_process');

/**
 * @typedef {import('./programmers/parser').Problem} Problem
 * @typedef {import('./runner').CaseResult} CaseResult
 */

/** @typedef {'hint' | 'approach' | 'full' | 'diagnose'} ExplainKind */

const SYSTEM_PROMPT = [
  '너는 코딩테스트를 공부하는 학습자의 튜터다.',
  '한국어로, 군더더기 없이, 학습자가 스스로 풀 수 있도록 돕는다.',
  '지시받은 수위를 반드시 지킨다 — 코드를 쓰지 말라고 하면 어떤 형태로도 코드를 쓰지 않는다.',
  '출력은 마크다운으로 하되 제목은 h3(###) 이하만 쓴다.',
].join(' ');

/** 버튼별 지시. 숙제이므로 수위를 단계로 나눈다. */
const KINDS = {
  hint: {
    label: '힌트',
    needsCode: false,
    instruction: [
      '아래 문제를 풀기 위한 **힌트만** 달라.',
      '필요한 개념·자료구조·접근 방향만 2~3문장으로 알려주고,',
      '정답 코드나 의사코드는 **절대 쓰지 마라**. 함수 이름 나열도 최소한으로.',
    ].join(' '),
  },
  approach: {
    label: '접근법',
    needsCode: true,
    instruction: [
      '아래 문제의 **접근법**을 단계별로 설명해 달라.',
      '"1단계: … 2단계: …" 형태의 말로 된 순서로 설명하고,',
      '실제 파이썬 코드는 **쓰지 마라**. 의사코드 수준까지만 허용한다.',
    ].join(' '),
  },
  full: {
    label: '전체 해설',
    needsCode: true,
    instruction: [
      '아래 문제의 **전체 해설**을 달라.',
      '① 접근법 ② 파이썬 모범 답안 코드 ③ 시간·공간 복잡도',
      '④ 내가 쓴 코드와의 차이(내 코드가 있다면) 순으로 정리해 달라.',
    ].join(' '),
  },
  diagnose: {
    label: '코드 진단',
    needsCode: true,
    instruction: [
      '아래는 내가 쓴 코드와 실패한 테스트 케이스다.',
      '**왜 틀렸는지 원인과 고쳐야 할 지점만** 짚어 달라.',
      '완성된 정답 코드는 **주지 마라** — 내가 직접 고칠 수 있게 방향만 알려 달라.',
    ].join(' '),
  },
};

/**
 * @typedef {Object} ExplainResult
 * @property {string} text
 * @property {number} ms
 * @property {number | null} costUsd
 */

/**
 * Claude Code CLI를 헤드리스로 돌려 해설을 받는다.
 *
 * 도구를 끄고(`--tools ""`) 시스템 프롬프트를 갈아끼워, 파일을 뒤지지 않고
 * 프롬프트에 담아 준 내용만으로 한 번에 답하게 한다.
 *
 * @param {Object} opts
 * @param {ExplainKind} opts.kind
 * @param {Problem} opts.problem
 * @param {string} [opts.code] 현재 solution.py 내용
 * @param {CaseResult[]} [opts.results] 로컬 테스트 결과
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<ExplainResult>}
 */
async function explain({ kind, problem, code, results, signal }) {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`알 수 없는 해설 종류: ${kind}`);

  const cfg = vscode.workspace.getConfiguration('codingTest');
  const bin = String(cfg.get('claudePath') || '').trim() || 'claude';
  const model = String(cfg.get('claudeModel') || '').trim() || 'sonnet';

  const prompt = buildPrompt(spec, problem, code, results);
  const started = Date.now();

  const raw = await run(bin, [
    '-p',
    '--output-format', 'json',
    '--model', model,
    '--tools', '',
    '--system-prompt', SYSTEM_PROMPT,
  ], prompt, signal);

  let text = raw.trim();
  /** @type {number | null} */
  let costUsd = null;
  try {
    const j = JSON.parse(raw);
    if (j && typeof j.result === 'string') text = j.result.trim();
    if (j && j.is_error) throw new Error(text || 'Claude가 오류를 반환했습니다.');
    if (j && typeof j.total_cost_usd === 'number') costUsd = j.total_cost_usd;
  } catch (e) {
    // JSON이 아니면 표준출력을 그대로 보여준다. 진짜 오류면 위에서 이미 던졌다.
    if (e instanceof Error && /Claude가 오류를/.test(e.message)) throw e;
  }

  if (!text) throw new Error('Claude가 빈 응답을 돌려줬습니다.');
  return { text, ms: Date.now() - started, costUsd };
}

/**
 * @param {(typeof KINDS)[ExplainKind]} spec
 * @param {Problem} problem
 * @param {string} [code]
 * @param {CaseResult[]} [results]
 * @returns {string}
 */
function buildPrompt(spec, problem, code, results) {
  const parts = [spec.instruction, '', '---', '', `# ${problem.title}`, '', problem.descriptionMd];

  if (spec.needsCode && code && code.trim()) {
    parts.push('', '---', '', '## 내가 쓴 코드 (solution.py)', '', '```python', code.trim(), '```');
  }

  const fn = problem.type === 'function';
  const failed = (results ?? []).filter((r) => r.status !== 'pass');

  if (failed.length > 0) {
    if (fn && problem.signature.length > 0) {
      parts.push('', '---', '', `함수 서명: \`solution(${problem.signature.join(', ')})\``);
    }
    parts.push('', '---', '', '## 실패한 테스트 케이스');

    for (const r of failed) {
      parts.push('', `### ${r.name} — ${statusLabel(r.status)}`);
      parts.push('', fn ? '인자:' : '입력:', '```', r.input || '(없음)', '```');
      parts.push(fn ? '기대한 반환값:' : '기대한 출력:', '```', r.expected, '```');
      parts.push(fn ? '실제 반환값:' : '실제 출력:', '```', r.actual || '(없음)', '```');
      if (r.stdout?.trim()) parts.push('코드가 찍은 출력:', '```', r.stdout.trim(), '```');
      if (r.stderr.trim()) parts.push('에러:', '```', r.stderr.trim(), '```');
    }
  }

  return parts.join('\n');
}

/**
 * @param {CaseResult['status']} s
 * @returns {string}
 */
function statusLabel(s) {
  return { pass: '통과', fail: '틀림', error: '실행 오류', timeout: '시간 초과' }[s] ?? s;
}

/**
 * 프롬프트를 stdin으로 넘긴다 — 길이·따옴표 문제를 원천 차단한다.
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {string} stdin
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
function run(bin, args, stdin, signal) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (e) {
      reject(notFound(bin, e));
      return;
    }

    let out = '';
    let err = '';
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));

    child.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      reject(notFound(bin, e));
    });

    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        reject(new Error('취소했습니다.'));
      } else if (code !== 0) {
        reject(new Error(`Claude CLI가 실패했습니다 (exit ${code}).\n${err.trim() || out.trim()}`));
      } else {
        resolve(out);
      }
    });

    child.stdin.on('error', () => {});
    child.stdin.end(stdin, 'utf8');
  });
}

/**
 * @param {string} bin
 * @param {unknown} e
 * @returns {Error}
 */
function notFound(bin, e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (/ENOENT/.test(msg)) {
    return new Error(
      `Claude Code CLI(\`${bin}\`)를 찾지 못했습니다. ` +
        '설치되어 있다면 설정 `codingTest.claudePath` 에 전체 경로를 넣어 주세요.'
    );
  }
  return new Error(`Claude CLI 실행 실패: ${msg}`);
}

module.exports = { explain, KINDS, SYSTEM_PROMPT };
