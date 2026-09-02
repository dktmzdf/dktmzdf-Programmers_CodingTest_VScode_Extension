// @ts-check
'use strict';

const { callClaude } = require('./explain');

/**
 * 클로드에게 엣지 케이스를 만들게 한다.
 *
 * 공식 예제는 보통 1~2개뿐이라 경계값에서 틀리는 걸 잡아내지 못한다.
 * 그 빈틈을 메우는 게 목적이다.
 *
 * **기대값도 클로드가 계산한다.** 그래서 틀릴 수 있다 — 저장 전에 사용자가 검토하고,
 * 담은 뒤에도 `source: 'ai'` 로 표시해 공식 예제와 구분한다.
 */

/**
 * @typedef {import('./programmers/parser').Problem} Problem
 * @typedef {import('./programmers/parser').TestCase} TestCase
 */

const SYSTEM_PROMPT = [
  '너는 코딩테스트 문제의 테스트 케이스를 설계하는 도우미다.',
  '요청받은 JSON 하나만 출력한다. 인사말·설명·마크다운 설명문을 덧붙이지 않는다.',
].join(' ');

/** 한 번에 제안할 최대 개수. 사람이 검토할 수 있는 양으로 묶는다. */
const MAX_CASES = 5;

/**
 * @param {Object} opts
 * @param {Problem} opts.problem
 * @param {TestCase[]} opts.existing   이미 있는 케이스 (중복 방지용)
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ cases: TestCase[], ms: number, costUsd: number | null }>}
 */
async function generate({ problem, existing, signal }) {
  const res = await callClaude({
    prompt: buildPrompt(problem, existing),
    systemPrompt: SYSTEM_PROMPT,
    signal,
  });

  const cases = parseProposals(res.text, problem);
  if (cases.length === 0) {
    throw new Error('쓸 만한 테스트 케이스를 만들지 못했습니다. 다시 시도해 주세요.');
  }
  return { cases, ms: res.ms, costUsd: res.costUsd };
}

/**
 * @param {Problem} problem
 * @param {TestCase[]} existing
 * @returns {string}
 */
function buildPrompt(problem, existing) {
  const fn = problem.type === 'function';

  const parts = [
    `아래 문제의 테스트 케이스를 최대 ${MAX_CASES}개 만들어라.`,
    '',
    '무엇을 노릴 것인가 — 공식 예제가 놓치는 **엣지 케이스**:',
    '- 제한사항의 경계값 (최소·최대)',
    '- 빈 값, 길이 1, 원소가 하나뿐인 경우',
    '- 음수·0, 중복 값, 이미 정렬된 경우와 역순인 경우',
    '- 답이 여러 개로 갈릴 수 있는 지점',
    '',
    '**기대값은 네가 직접 정확히 계산해서 채워라.** 계산에 확신이 없으면 그 케이스는 아예 빼라.',
    '이미 있는 케이스와 같거나 사실상 같은 것은 만들지 마라.',
    '',
  ];

  if (fn) {
    parts.push(
      `함수 서명: \`solution(${problem.signature.join(', ')})\``,
      '',
      '출력 형식 — 이 JSON **하나만**:',
      '```json',
      '{"cases":[{"name":"짧은 이름","why":"왜 이 케이스가 중요한지 한 줄",' +
        '"args":["<인자1>","<인자2>"],"expected":"<반환값>"}]}',
      '```',
      '',
      '`args` 와 `expected` 는 **파이썬 리터럴을 문자열로 감싼 것**이다.',
      '문자열은 `"\\"abc\\""`, 숫자는 `"3"`, 배열은 `"[1, 2, 3]"`, 참/거짓은 `"True"` / `"False"`.',
      `\`args\` 의 길이는 반드시 ${problem.signature.length} 이어야 한다.`
    );
  } else {
    parts.push(
      '출력 형식 — 이 JSON **하나만**:',
      '```json',
      '{"cases":[{"name":"짧은 이름","why":"왜 이 케이스가 중요한지 한 줄",' +
        '"input":"<표준입력>","expected":"<표준출력>"}]}',
      '```',
      '',
      '`input` 은 프로그램에 넣을 표준입력 전체, `expected` 는 기대하는 표준출력 전체다.',
      '줄바꿈이 필요하면 JSON 문자열 안에서 `\\n` 으로 쓴다.'
    );
  }

  parts.push('', '---', '', `# ${problem.title}`, '', problem.descriptionMd);

  if (existing.length > 0) {
    parts.push('', '---', '', '## 이미 있는 케이스 (중복 금지)');
    for (const c of existing) {
      parts.push(
        fn
          ? `- ${c.name}: solution(${(c.args ?? []).join(', ')}) -> ${c.expected}`
          : `- ${c.name}: 입력 ${JSON.stringify(c.input ?? '')} -> 출력 ${JSON.stringify(c.expected)}`
      );
    }
  }

  return parts.join('\n');
}

/**
 * 클로드 답변에서 케이스를 뽑아낸다.
 *
 * 모델이 코드펜스로 감싸거나 앞뒤에 말을 붙이는 경우가 있어, JSON만 도려낸 뒤
 * 형식에 맞지 않는 항목은 조용히 버린다. 잘못된 케이스를 넣느니 빼는 게 낫다.
 *
 * @param {string} text
 * @param {Problem} problem
 * @returns {TestCase[]}
 */
function parseProposals(text, problem) {
  const json = extractJson(text);
  if (!json) throw new Error('Claude 응답에서 JSON을 찾지 못했습니다.');

  let data;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('Claude가 돌려준 JSON을 해석하지 못했습니다.');
  }

  const list = Array.isArray(data) ? data : Array.isArray(data?.cases) ? data.cases : null;
  if (!list) throw new Error('Claude 응답에 cases 배열이 없습니다.');

  const fn = problem.type === 'function';
  const want = problem.signature.length;

  /** @type {TestCase[]} */
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    if (typeof raw.expected !== 'string') continue;

    const name = text2(raw.name) || `AI 케이스 ${out.length + 1}`;
    const why = text2(raw.why);

    if (fn) {
      if (!Array.isArray(raw.args)) continue;
      const args = raw.args.map((/** @type {unknown} */ a) => String(a).trim());
      if (args.some((/** @type {string} */ a) => !a)) continue;
      // 인자 개수가 서명과 다르면 실행 자체가 안 된다 — 버린다.
      if (want > 0 && args.length !== want) continue;
      out.push({ name, why, args, expected: raw.expected.trim(), source: 'ai' });
    } else {
      if (typeof raw.input !== 'string') continue;
      out.push({ name, why, input: raw.input, expected: raw.expected, source: 'ai' });
    }
    if (out.length >= MAX_CASES) break;
  }
  return out;
}

/**
 * 코드펜스나 앞뒤 설명에 섞여 온 JSON 덩어리를 도려낸다.
 * @param {string} text
 * @returns {string | null}
 */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;

  const start = body.search(/[[{]/);
  if (start === -1) return null;
  const close = body[start] === '{' ? '}' : ']';
  const end = body.lastIndexOf(close);
  if (end <= start) return null;

  return body.slice(start, end + 1);
}

/**
 * @param {unknown} v
 * @returns {string}
 */
function text2(v) {
  return typeof v === 'string' ? v.trim() : '';
}

module.exports = { generate, parseProposals, buildPrompt, MAX_CASES, SYSTEM_PROMPT };
