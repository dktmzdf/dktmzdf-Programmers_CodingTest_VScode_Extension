// @ts-check
'use strict';

const { decodeEntities, stripTags, extractBalancedDiv, htmlToMarkdown } = require('../html2md');

const ORIGIN = 'https://school.programmers.co.kr';

/**
 * 테스트 케이스. 문제 형식에 따라 채워지는 칸이 다르다.
 *
 * - 표준입출력형: `input` (프로그램에 넣을 표준입력)
 * - 함수형: `args` (매개변수 순서대로, **파이썬 리터럴 원문 그대로**)
 *
 * @typedef {Object} TestCase
 * @property {string} name
 * @property {'official' | 'user' | 'ai'} source  사이트 예제 / 내가 넣은 것 / 클로드 제안
 * @property {string} expected
 * @property {string} [input]
 * @property {string[]} [args]
 * @property {string} [why]  클로드가 제안한 이유 (source가 'ai'일 때만)
 */

/**
 * @typedef {Object} Problem
 * @property {number} courseId
 * @property {number} lessonId
 * @property {string} title
 * @property {string} url
 * @property {'stdio' | 'function' | 'unknown'} type
 * @property {string[]} signature      함수형일 때 `solution()` 의 매개변수 이름들
 * @property {string} descriptionHtml
 * @property {string} descriptionMd
 * @property {TestCase[]} cases
 * @property {string} initialCode
 * @property {string | null} csrfToken
 * @property {string | null} codeId          에디터 코드 레코드 id (채점 요청의 codes 키)
 * @property {number | null} challengeableId ActionCable 구독에 쓰는 id
 * @property {string} challengeableType      보통 "algorithm"
 * @property {string} language               보통 "python3"
 * @property {string | null} actionCableUrl
 * @property {boolean} loggedIn
 */

/**
 * 문제 URL(또는 lesson 번호)에서 course/lesson id를 뽑는다.
 * @param {string} raw
 * @returns {{ courseId: number, lessonId: number, url: string }}
 */
function parseLessonUrl(raw) {
  const s = raw.trim();

  const full = s.match(/\/learn\/courses\/(\d+)\/lessons\/(\d+)/);
  if (full) return canonical(Number(full[1]), Number(full[2]));

  if (/^\d+$/.test(s)) return canonical(30, Number(s));

  throw new Error(
    '프로그래머스 문제 URL이 아닙니다. ' +
      '예: https://school.programmers.co.kr/learn/courses/30/lessons/181950'
  );
}

/**
 * @param {number} courseId
 * @param {number} lessonId
 * @returns {{ courseId: number, lessonId: number, url: string }}
 */
function canonical(courseId, lessonId) {
  return {
    courseId,
    lessonId,
    url: `${ORIGIN}/learn/courses/${courseId}/lessons/${lessonId}?language=python3`,
  };
}

/**
 * 문제 페이지 HTML을 파싱한다.
 * @param {string} html
 * @param {string} url 상대 경로를 절대화할 기준 URL
 * @returns {Problem}
 */
function parseLessonPage(html, url) {
  const descriptionHtml = extractDescription(html);
  const initialCode = extractInitialCode(html);
  const signature = parseSignature(initialCode) ?? [];

  const stdioCases = extractStdioCases(descriptionHtml);
  const type = detectType(html, descriptionHtml, stdioCases);
  const cases = type === 'function' ? extractFunctionCases(descriptionHtml, signature) : stdioCases;

  const fromUrl = parseLessonUrl(url);

  return {
    courseId: num(html, /\bdata-course-id="(\d+)"/) ?? fromUrl.courseId,
    lessonId: num(html, /\bdata-lesson-id="(\d+)"/) ?? fromUrl.lessonId,
    title:
      str(html, /\bdata-lesson-title="([^"]*)"/) ??
      str(html, /algorithm-title">([^<]*)</) ??
      '제목 없음',
    url,
    type,
    signature,
    descriptionHtml,
    descriptionMd: htmlToMarkdown(descriptionHtml, url),
    cases,
    initialCode,
    csrfToken: str(html, /<meta\s+name="csrf-token"\s+content="([^"]*)"/i),
    codeId: str(html, /\bid="initial_code_(\d+)"/),
    challengeableId: num(html, /\bdata-challengeable-id="(\d+)"/),
    challengeableType: str(html, /\bdata-challengeable-type="([^"]*)"/) ?? 'algorithm',
    language: str(html, /\bdata-language="([^"]*)"/) ?? 'python3',
    actionCableUrl: str(html, /<meta\s+name="action-cable-url"\s+content="([^"]*)"/i),
    // 로그인 여부는 `data-user-id` 로 판단한다 — 비로그인이면 빈 값이고
    // 로그인하면 사용자 번호가 들어간다. 버튼 모양이나 로그인 링크 유무보다
    // 훨씬 확실하다.
    loggedIn: /\bdata-user-id="\d+"/.test(html),
  };
}

/**
 * 문제 형식을 가른다.
 *
 * 페이지가 `data-interface-type` 으로 형식을 직접 알려준다 — 로그인 없이도 붙어
 * 있고 `stdio` / `function` 값이 정확하다. 속성이 사라지는 경우에만 본문 모양으로
 * 추측한다 (표준입출력형은 "입력 #N" 블록, 함수형은 `<table class="table">`).
 *
 * @param {string} html
 * @param {string} descriptionHtml
 * @param {TestCase[]} stdioCases
 * @returns {'stdio' | 'function' | 'unknown'}
 */
function detectType(html, descriptionHtml, stdioCases) {
  const declared = str(html, /\bdata-interface-type="([^"]*)"/);
  if (declared === 'stdio') return 'stdio';
  if (declared === 'function') return 'function';

  if (stdioCases.length > 0) return 'stdio';
  if (/<table[^>]*\bclass="[^"]*\btable\b/i.test(descriptionHtml)) return 'function';
  return 'unknown';
}

/**
 * 시작 코드의 `def solution(...)` 에서 매개변수 이름을 뽑는다.
 * 표 헤더에도 같은 이름이 있지만, 실제 호출 규약은 코드 쪽이 정본이다.
 *
 * @param {string} code
 * @returns {string[] | null}
 */
function parseSignature(code) {
  const m = code.match(/def\s+solution\s*\(([^)]*)\)/);
  if (!m) return null;

  const inner = m[1].trim();
  if (!inner) return [];

  return inner
    .split(',')
    .map((p) => p.split('=')[0].split(':')[0].trim())
    .filter(Boolean);
}

/**
 * `<div class="markdown solarized-dark">` 안쪽 전체를 꺼낸다.
 * @param {string} html
 * @returns {string}
 */
function extractDescription(html) {
  const open = html.match(/<div[^>]*\bclass="[^"]*\bmarkdown\b[^"]*"[^>]*>/i);
  if (!open || open.index === undefined) {
    throw new Error('문제 본문을 찾지 못했습니다. 페이지 구조가 바뀌었을 수 있습니다.');
  }
  const body = extractBalancedDiv(html, open.index);
  if (body === null) {
    throw new Error('문제 본문의 닫는 태그를 찾지 못했습니다.');
  }
  return body;
}

/**
 * 표준입출력형 예제를 뽑는다.
 *
 * 실측된 구조:
 *   <p>입력 #1</p><div class="highlight"><pre class="codehilite"><code>string 5
 *   </code></pre></div>
 *   <p>출력 #1</p><div class="highlight"><pre class="codehilite"><code>...</code></pre></div>
 *
 * @param {string} descriptionHtml
 * @returns {TestCase[]}
 */
function extractStdioCases(descriptionHtml) {
  const re =
    /<p>\s*(입력|출력)\s*#\s*(\d+)\s*<\/p>\s*(?:<div[^>]*>\s*)?<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi;

  /** @type {Map<number, { input?: string, expected?: string }>} */
  const byNo = new Map();

  for (const m of descriptionHtml.matchAll(re)) {
    const kind = m[1];
    const no = Number(m[2]);
    const body = normalize(decodeEntities(String(m[3])));

    const slot = byNo.get(no) ?? {};
    if (kind === '입력') slot.input = body;
    else slot.expected = body;
    byNo.set(no, slot);
  }

  /** @type {TestCase[]} */
  const cases = [];
  for (const no of [...byNo.keys()].sort((a, b) => a - b)) {
    const slot = byNo.get(no);
    // 입력·출력이 짝을 이루지 않으면 테스트로 못 쓴다.
    if (!slot || slot.input === undefined || slot.expected === undefined) continue;
    cases.push({ name: `예제 ${no}`, input: slot.input, expected: slot.expected, source: 'official' });
  }
  return cases;
}

/**
 * 함수형 문제의 입출력 예 표를 읽는다.
 *
 * 실측된 구조 (lesson 181943):
 *   <table class="table">
 *     <thead><tr><th>my_string</th><th>overwrite_string</th><th>s</th><th>result</th></tr></thead>
 *     <tbody><tr><td>"He11oWor1d"</td><td>"lloWorl"</td><td>2</td><td>"HelloWorld"</td></tr></tbody>
 *   </table>
 *
 * 마지막 열이 기대값이다 — 이름이 `result`/`return`/`answer` 로 제각각이라 위치로 잡는다.
 * 셀 값은 파싱하지 않고 **원문 그대로** 넘긴다. 파이썬 하네스가 실행 직전에 해석한다.
 *
 * @param {string} descriptionHtml
 * @param {string[]} signature
 * @returns {TestCase[]}
 */
function extractFunctionCases(descriptionHtml, signature) {
  const table = pickTable(descriptionHtml, signature);
  if (!table) return [];

  const { header, rows } = table;
  const columns = mapColumns(header, signature);

  /** @type {TestCase[]} */
  const cases = [];
  for (const row of rows) {
    // 기대값은 언제나 마지막 열이다.
    if (row.length < columns.length + 1) continue;

    const args = columns.map((i) => row[i]);
    const expected = row[row.length - 1];
    if (args.some((a) => a === undefined) || expected === undefined) continue;

    cases.push({ name: `예제 ${cases.length + 1}`, args, expected, source: 'official' });
  }
  return cases;
}

/**
 * 설명 안의 표 중 입출력 예 표를 고른다.
 *
 * @param {string} descriptionHtml
 * @param {string[]} signature
 * @returns {{ header: string[], rows: string[][] } | null}
 */
function pickTable(descriptionHtml, signature) {
  /** @type {{ header: string[], rows: string[][] }[]} */
  const tables = [];

  for (const m of descriptionHtml.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    const parsed = parseTable(String(m[1]));
    if (parsed) tables.push(parsed);
  }
  if (tables.length === 0) return null;

  // 1순위: 헤더에 매개변수 이름이 전부 들어 있는 표
  const byName = tables.find((t) =>
    signature.length > 0 && signature.every((p) => t.header.includes(p))
  );
  if (byName) return byName;

  // 2순위: 열 개수가 매개변수 수 + 1 인 표
  const byWidth = tables.find((t) => t.header.length === signature.length + 1);
  if (byWidth) return byWidth;

  return tables[0];
}

/**
 * `<table>` 안쪽을 헤더 한 줄과 본문 줄들로 나눈다.
 * @param {string} body
 * @returns {{ header: string[], rows: string[][] } | null}
 */
function parseTable(body) {
  /** @type {{ cells: string[], isHeader: boolean }[]} */
  const all = [];

  for (const tr of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    /** @type {string[]} */
    const cells = [];
    let isHeader = false;
    for (const td of String(tr[1]).matchAll(/<t([hd])[^>]*>([\s\S]*?)<\/t\1>/gi)) {
      if (String(td[1]).toLowerCase() === 'h') isHeader = true;
      cells.push(cellText(String(td[2])));
    }
    if (cells.length > 0) all.push({ cells, isHeader });
  }
  if (all.length < 2) return null;

  // `<th>` 로 된 줄이 있으면 그게 헤더, 없으면 첫 줄을 헤더로 본다.
  const headerIdx = all.findIndex((r) => r.isHeader);
  const hi = headerIdx === -1 ? 0 : headerIdx;

  return {
    header: all[hi].cells,
    rows: all.filter((_, i) => i !== hi).map((r) => r.cells),
  };
}

/**
 * 표 셀에서 값 텍스트만 꺼낸다.
 * @param {string} html
 * @returns {string}
 */
function cellText(html) {
  return stripTags(html.replace(/<br\s*\/?>/gi, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * 매개변수 하나하나가 표의 몇 번째 열인지 정한다.
 * 헤더 이름이 매개변수 이름과 맞으면 그걸 쓰고, 아니면 앞에서부터 순서대로 맞춘다.
 *
 * @param {string[]} header
 * @param {string[]} signature
 * @returns {number[]}
 */
function mapColumns(header, signature) {
  if (signature.length === 0) {
    // 시그니처를 못 읽었으면 마지막 열만 기대값으로 보고 나머지를 인자로 쓴다.
    return header.slice(0, -1).map((_, i) => i);
  }

  const byName = signature.map((p) => header.indexOf(p));
  if (byName.every((i) => i >= 0)) return byName;

  return signature.map((_, i) => i);
}

/**
 * 에디터에 채워져 있는 시작 코드.
 * @param {string} html
 * @returns {string}
 */
function extractInitialCode(html) {
  const ta = html.match(/<textarea[^>]*\bid="code"[^>]*>([\s\S]*?)<\/textarea>/i);
  if (ta) return normalize(decodeEntities(ta[1]));

  const input = html.match(/<input[^>]*\bid="initial_code_\d+"[^>]*\bvalue="([^"]*)"/i);
  if (input) return normalize(decodeEntities(input[1]));

  return '';
}

/**
 * 페이지에 따라 CRLF와 LF가 섞여 온다. 파일로 쓰기 전에 LF로 통일한다.
 * @param {string} s
 * @returns {string}
 */
function normalize(s) {
  return s.replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

/**
 * @param {string} html
 * @param {RegExp} re
 * @returns {string | null}
 */
function str(html, re) {
  const m = html.match(re);
  return m ? decodeEntities(m[1]) : null;
}

/**
 * @param {string} html
 * @param {RegExp} re
 * @returns {number | null}
 */
function num(html, re) {
  const m = html.match(re);
  return m ? Number(m[1]) : null;
}

module.exports = {
  ORIGIN,
  parseLessonUrl,
  parseLessonPage,
  parseSignature,
  extractFunctionCases,
};
