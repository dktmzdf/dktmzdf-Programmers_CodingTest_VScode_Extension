// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseLessonUrl, parseLessonPage } = require('../src/programmers/parser');

const FIXTURES = path.join(__dirname, 'fixtures');

/**
 * 픽스처마다 기대하는 파싱 결과.
 * 사이트가 페이지 구조를 바꾸면 여기가 먼저 깨진다.
 */
const EXPECT = {
  // ---- 표준입출력형 ----
  181950: {
    title: '문자열 반복해서 출력하기',
    type: 'stdio',
    signature: [],
    challengeableId: 17584,
    codeId: '62536',
    cases: 1,
    first: { input: 'string 5', expected: 'stringstringstringstringstring' },
  },
  181951: {
    title: 'a와 b 출력하기',
    type: 'stdio',
    signature: [],
    challengeableId: 17583,
    codeId: '62525',
    cases: 1,
    // 출력이 여러 줄인 경우
    first: { input: '4 5', expected: 'a = 4\nb = 5' },
  },

  // ---- 함수형 ----
  181943: {
    title: '문자열 겹쳐쓰기',
    type: 'function',
    signature: ['my_string', 'overwrite_string', 's'],
    challengeableId: 17590,
    codeId: '63198',
    cases: 2,
    // 매개변수 3개 · 문자열과 정수가 섞인 경우
    first: { args: ['"He11oWor1d"', '"lloWorl"', '2'], expected: '"HelloWorld"' },
  },
  12910: {
    title: '나누어 떨어지는 숫자 배열',
    type: 'function',
    signature: ['arr', 'divisor'],
    challengeableId: 899,
    codeId: '2721',
    cases: 3,
    // 결과 열 이름이 `return` 인 경우
    first: { args: ['[5, 9, 7, 10]', '5'], expected: '[5, 10]' },
  },
  12915: {
    title: '문자열 내 마음대로 정렬하기',
    type: 'function',
    signature: ['strings', 'n'],
    challengeableId: 904,
    codeId: '3338',
    cases: 2,
    // 문자열 배열
    first: { args: ['["sun", "bed", "car"]', '1'], expected: '["car", "bed", "sun"]' },
  },
  12916: {
    title: '문자열 내 p와 y의 개수',
    type: 'function',
    signature: ['s'],
    challengeableId: 286,
    codeId: '975',
    cases: 2,
    // ⚠️ 불린을 소문자 true/false 로 적는 경우 — ast.literal_eval 단독이면 깨진다
    first: { args: ['"pPoooyY"'], expected: 'true' },
  },
  12949: {
    title: '행렬의 곱셈',
    type: 'function',
    signature: ['arr1', 'arr2'],
    challengeableId: 1473,
    codeId: '4529',
    cases: 2,
    // 중첩 배열
    first: {
      args: ['[[1, 4], [3, 2], [4, 1]]', '[[3, 3], [3, 3]]'],
      expected: '[[15, 15], [15, 15], [15, 15]]',
    },
  },
  87389: {
    title: '나머지가 1이 되는 수 찾기',
    type: 'function',
    signature: ['n'],
    challengeableId: 9063,
    codeId: '32922',
    cases: 2,
    first: { args: ['10'], expected: '3' },
  },
  120802: {
    title: '두 수의 합 구하기',
    type: 'function',
    signature: ['num1', 'num2'],
    challengeableId: 14641,
    codeId: '49579',
    cases: 2,
    first: { args: ['2', '3'], expected: '5' },
  },
};

/**
 * @param {import('./assert').Suite} t
 */
module.exports = function parserTests(t) {
  t.section('파서 — 문제 페이지 파싱');

  for (const [id, want] of Object.entries(EXPECT)) {
    const file = path.join(FIXTURES, id + '.html');
    if (!fs.existsSync(file)) {
      t.skip(`${id}`, '픽스처가 없다 (fixtures/refresh.ps1 로 받는다)');
      continue;
    }

    const { url } = parseLessonUrl(id);
    let p;
    try {
      p = parseLessonPage(fs.readFileSync(file, 'utf8'), url);
    } catch (e) {
      t.ok(`${id} 파싱`, false, e instanceof Error ? e.message : String(e));
      continue;
    }

    t.eq(`${id} 제목`, p.title, want.title);
    t.eq(`${id} 형식`, p.type, want.type);
    t.eq(`${id} 시그니처`, p.signature, want.signature);
    t.eq(`${id} challengeableId`, p.challengeableId, want.challengeableId);
    t.eq(`${id} codeId`, p.codeId, want.codeId);
    t.eq(`${id} 케이스 수`, p.cases.length, want.cases);

    const first = p.cases[0];
    if (!first) {
      t.ok(`${id} 첫 케이스`, false, '케이스가 하나도 없다');
      continue;
    }
    if ('args' in want.first) {
      t.eq(`${id} 첫 케이스 인자`, first.args, want.first.args);
    } else {
      t.eq(`${id} 첫 케이스 입력`, first.input, want.first.input);
    }
    t.eq(`${id} 첫 케이스 기대값`, first.expected, want.first.expected);

    // 채점에 필요한 값들이 비어 있지 않은지
    t.ok(`${id} csrf 토큰 존재`, Boolean(p.csrfToken));
    t.ok(`${id} 케이블 URL 존재`, Boolean(p.actionCableUrl));
    t.ok(`${id} 시작 코드 존재`, p.initialCode.length > 0);
  }

  t.section('파서 — URL 해석');
  t.eq('전체 URL', parseLessonUrl('https://school.programmers.co.kr/learn/courses/30/lessons/181943?language=python3').lessonId, 181943);
  t.eq('번호만', parseLessonUrl('181943').lessonId, 181943);
  t.eq('번호만 → 기본 코스', parseLessonUrl('181943').courseId, 30);
  t.ok('엉뚱한 값은 거부', (() => {
    try {
      parseLessonUrl('https://example.com/foo');
      return false;
    } catch {
      return true;
    }
  })());
};
