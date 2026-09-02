// @ts-check
'use strict';

const { install } = require('./_vscode-stub');
install(); // testgen → explain → vscode

const { parseProposals, buildPrompt, MAX_CASES } = require('../src/testgen');

/** @type {any} */
const STDIO = { type: 'stdio', signature: [], title: '문자열 반복', descriptionMd: '설명' };
/** @type {any} */
const FUNC = {
  type: 'function',
  signature: ['my_string', 'overwrite_string', 's'],
  title: '문자열 겹쳐쓰기',
  descriptionMd: '설명',
};

/**
 * 클로드 응답은 형식이 흔들린다 — 코드펜스로 감싸거나 앞뒤에 말을 붙인다.
 * 그걸 견디는지, 그리고 **못 믿을 케이스는 조용히 버리는지**가 핵심이다.
 *
 * @param {import('./assert').Suite} t
 */
module.exports = function testgenTests(t) {
  t.section('테스트 케이스 생성 — 응답 파싱');

  // --- 형식이 흔들려도 읽어내는가 ---
  {
    const raw = '{"cases":[{"name":"빈 입력","why":"경계","input":"a 1","expected":"a"}]}';
    const got = parseProposals(raw, STDIO);
    t.eq('맨 JSON', got.length, 1);
    t.eq('  이름', got[0].name, '빈 입력');
    t.eq('  이유', got[0].why, '경계');
    t.eq('  입력', got[0].input, 'a 1');
    t.eq('  기대값', got[0].expected, 'a');
    t.eq('  출처 표시', got[0].source, 'ai');
  }

  t.eq(
    '```json 코드펜스로 감싼 경우',
    parseProposals('```json\n{"cases":[{"name":"n","input":"1","expected":"1"}]}\n```', STDIO).length,
    1
  );

  t.eq(
    '앞뒤에 말이 붙은 경우',
    parseProposals(
      '알겠습니다. 아래가 제안입니다:\n\n```\n{"cases":[{"name":"n","input":"1","expected":"1"}]}\n```\n\n도움이 되길!',
      STDIO
    ).length,
    1
  );

  t.eq(
    '최상위가 배열인 경우',
    parseProposals('[{"name":"n","input":"1","expected":"1"}]', STDIO).length,
    1
  );

  // --- 함수형: 인자 개수 ---
  {
    const ok = '{"cases":[{"name":"n","args":["\\"abc\\"","\\"b\\"","1"],"expected":"\\"abc\\""}]}';
    const got = parseProposals(ok, FUNC);
    t.eq('함수형 — 인자 3개면 통과', got.length, 1);
    t.eq('  인자 보존', got[0].args, ['"abc"', '"b"', '1']);
  }

  t.eq(
    '함수형 — 인자 개수가 서명과 다르면 버린다',
    parseProposals('{"cases":[{"name":"n","args":["1"],"expected":"1"}]}', FUNC).length,
    0
  );

  // --- 못 믿을 항목은 버린다 ---
  t.eq(
    'expected 없으면 버린다',
    parseProposals('{"cases":[{"name":"n","input":"1"}]}', STDIO).length,
    0
  );
  t.eq(
    'stdio 인데 input 이 없으면 버린다',
    parseProposals('{"cases":[{"name":"n","expected":"1"}]}', STDIO).length,
    0
  );
  t.eq(
    '함수형인데 args 가 배열이 아니면 버린다',
    parseProposals('{"cases":[{"name":"n","args":"1","expected":"1"}]}', FUNC).length,
    0
  );
  {
    // 멀쩡한 것만 남기고 나머지는 버려야 한다.
    const mixed =
      '{"cases":[{"name":"good","input":"1","expected":"1"},' +
      '{"name":"bad"},{"nope":true},null,' +
      '{"name":"good2","input":"2","expected":"2"}]}';
    t.eq('섞여 있으면 멀쩡한 것만', parseProposals(mixed, STDIO).length, 2);
  }

  // --- 개수 상한 ---
  {
    const many = JSON.stringify({
      cases: Array.from({ length: MAX_CASES + 4 }, (_, i) => ({
        name: 'c' + i, input: String(i), expected: String(i),
      })),
    });
    t.eq(`${MAX_CASES}개를 넘지 않는다`, parseProposals(many, STDIO).length, MAX_CASES);
  }

  // --- 아예 못 읽는 경우는 던진다 (조용히 0개로 넘어가면 원인을 모른다) ---
  /** @param {() => unknown} fn */
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };

  t.ok('JSON이 아예 없으면 던진다', throws(() => parseProposals('죄송합니다, 못 만들겠습니다.', STDIO)));
  t.ok('깨진 JSON이면 던진다', throws(() => parseProposals('{"cases":[{', STDIO)));
  t.ok('cases 배열이 없으면 던진다', throws(() => parseProposals('{"result":"ok"}', STDIO)));

  // --- 프롬프트가 형식을 제대로 지시하는가 ---
  t.section('테스트 케이스 생성 — 프롬프트');
  {
    const p = buildPrompt(FUNC, [
      { name: '예제 1', source: 'official', args: ['"x"', '"y"', '2'], expected: '"z"' },
    ]);
    t.ok('함수 서명을 알려준다', p.includes('solution(my_string, overwrite_string, s)'), p.slice(0, 200));
    t.ok('args 길이를 못박는다', p.includes('3 이어야 한다'));
    t.ok('기존 케이스를 중복 방지용으로 넘긴다', p.includes('중복 금지') && p.includes('예제 1'));
    t.ok('문제 본문을 담는다', p.includes('문자열 겹쳐쓰기'));
  }
  {
    const p = buildPrompt(STDIO, []);
    t.ok('표준입출력형은 input/expected 형식을 지시', p.includes('"input"') && p.includes('표준입력'));
    t.ok('기존 케이스가 없으면 그 절은 생략', !p.includes('중복 금지'));
  }
};
