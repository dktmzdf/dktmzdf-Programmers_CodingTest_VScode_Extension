// @ts-check
'use strict';

/**
 * 프로그래머스 문제 본문에 실제로 쓰이는 태그만 다루는 소형 HTML→Markdown 변환기.
 * 확인된 태그: p, br, hr, h1~h6, ul, ol, li, pre>code, code, strong, em, a, img, table.
 * 범용 변환기가 아니라 이 사이트의 본문 전용이다.
 */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»',
  le: '≤', ge: '≥', ne: '≠', times: '×', divide: '÷', minus: '−',
  larr: '←', rarr: '→', harr: '↔', infin: '∞', middot: '·', bull: '•',
};

/** 코드 블록 자리표시자. 이 토큰은 HTML 본문에 사실상 없고, 태그 제거·엔티티 디코드·
 *  공백 정리를 전부 통과해도 살아남기 때문에 안전한 앵커가 된다. */
const CB_OPEN = '@@CB';
const CB_CLOSE = '@@';
const CB_RE = /@@CB(\d+)@@/g;

/**
 * HTML 엔티티를 실제 문자로 되돌린다. (`&#39;` 같은 수치 참조 포함)
 * @param {string} s
 * @returns {string}
 */
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name) => {
      const v = /** @type {Record<string, string>} */ (NAMED_ENTITIES)[name.toLowerCase()];
      return v === undefined ? m : v;
    });
}

/**
 * @param {number} cp
 * @returns {string}
 */
function safeFromCodePoint(cp) {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return '';
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

/**
 * 모든 태그를 제거하고 엔티티를 디코드한다.
 * @param {string} html
 * @returns {string}
 */
function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).trim();
}

/**
 * `<div ...>` 여는 태그 위치에서 시작해, 짝이 맞는 `</div>` 까지의 **안쪽**
 * 내용을 돌려준다. 중첩 div를 세면서 스캔하므로 안전하다.
 * @param {string} html
 * @param {number} openTagStart `<div` 의 `<` 위치
 * @returns {string | null}
 */
function extractBalancedDiv(html, openTagStart) {
  const openEnd = html.indexOf('>', openTagStart);
  if (openEnd === -1) return null;

  let depth = 1;
  let i = openEnd + 1;
  const contentStart = i;

  while (i < html.length && depth > 0) {
    const nextOpen = html.indexOf('<div', i);
    const nextClose = html.indexOf('</div', i);
    if (nextClose === -1) return null;

    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + 4;
    } else {
      depth--;
      if (depth === 0) return html.slice(contentStart, nextClose);
      i = nextClose + 5;
    }
  }
  return null;
}

/**
 * 문제 본문 HTML을 Markdown으로 바꾼다.
 * @param {string} html
 * @param {string} [baseUrl] 상대 경로 이미지·링크를 절대 URL로 바꿀 기준
 * @returns {string}
 */
function htmlToMarkdown(html, baseUrl) {
  /** @type {string[]} */
  const codeBlocks = [];
  let s = html.replace(/\r\n/g, '\n');

  // 1) 코드 블록을 먼저 빼둔다 — 안쪽 내용은 어떤 변환도 받으면 안 된다.
  s = s.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_, body) => {
    const idx = codeBlocks.push(decodeEntities(String(body)).replace(/\n+$/, '')) - 1;
    return CB_OPEN + idx + CB_CLOSE;
  });
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, body) => {
    const idx = codeBlocks.push(decodeEntities(stripTagsKeepNewlines(String(body)))) - 1;
    return CB_OPEN + idx + CB_CLOSE;
  });

  // 2) 표 → Markdown 표 (제한사항에 드물게 등장)
  s = s.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, body) => tableToMarkdown(String(body)));

  // 3) 블록 요소
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n\n---\n\n')
    .replace(/<\/(p|div|section|article)>/gi, '\n\n')
    .replace(/<(p|div|section|article)[^>]*>/gi, '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_, lvl, body) => '\n\n' + '#'.repeat(Number(lvl)) + ' ' + inline(String(body)) + '\n\n')
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
      (_, body) => '\n\n' + String(body).trim().split('\n').map((l) => '> ' + l).join('\n') + '\n\n');

  // 4) 목록 — 중첩은 다루지 않는다 (본문에 나온 적 없음)
  s = s.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, body) => {
    let n = 0;
    return '\n' + String(body).replace(/<li[^>]*>([\s\S]*?)<\/li>/gi,
      (__, item) => ++n + '. ' + inline(String(item)) + '\n') + '\n';
  });
  s = s.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, body) =>
    '\n' + String(body).replace(/<li[^>]*>([\s\S]*?)<\/li>/gi,
      (__, item) => '- ' + inline(String(item)) + '\n') + '\n');

  // 5) 인라인
  s = inline(s, baseUrl);

  // 6) 남은 태그 제거 + 엔티티 디코드
  s = decodeEntities(s.replace(/<[^>]*>/g, ''));

  // 7) 코드 블록 복원
  s = s.replace(CB_RE, (_, i) => '\n```\n' + (codeBlocks[Number(i)] ?? '') + '\n```\n');

  // 8) 공백 정리
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 인라인 태그만 변환한다.
 * @param {string} s
 * @param {string} [baseUrl]
 * @returns {string}
 */
function inline(s, baseUrl) {
  return s
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi,
      (_, body) => '`' + decodeEntities(String(body).replace(/<[^>]*>/g, '')) + '`')
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, body) => '**' + String(body).trim() + '**')
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, body) => '*' + String(body).trim() + '*')
    .replace(/<img[^>]*\bsrc="([^"]*)"[^>]*>/gi, (_, src) => '![](' + absolutize(String(src), baseUrl) + ')')
    .replace(/<a[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_, href, body) => '[' + stripTags(String(body)) + '](' + absolutize(String(href), baseUrl) + ')')
    .replace(/[ \t]*\n[ \t]*/g, '\n');
}

/**
 * @param {string} body `<table>` 안쪽
 * @returns {string}
 */
function tableToMarkdown(body) {
  const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
    [...String(m[1]).matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) =>
      inline(String(c[1])).replace(/<[^>]*>/g, '').replace(/\n/g, ' ').trim()
    )
  );
  if (rows.length === 0) return '';

  const width = Math.max(...rows.map((r) => r.length));
  const pad = (/** @type {string[]} */ r) =>
    '| ' + [...r, ...Array(width - r.length).fill('')].join(' | ') + ' |';

  const sep = '| ' + Array(width).fill('---').join(' | ') + ' |';
  return '\n\n' + [pad(rows[0]), sep, ...rows.slice(1).map(pad)].join('\n') + '\n\n';
}

/**
 * @param {string} html
 * @returns {string}
 */
function stripTagsKeepNewlines(html) {
  return html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '');
}

/**
 * 상대 URL을 절대 URL로 바꾼다. 실패하면 원본을 그대로 둔다.
 * @param {string} url
 * @param {string} [baseUrl]
 * @returns {string}
 */
function absolutize(url, baseUrl) {
  if (!baseUrl) return url;
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

module.exports = {
  decodeEntities,
  stripTags,
  extractBalancedDiv,
  htmlToMarkdown,
  absolutize,
};
