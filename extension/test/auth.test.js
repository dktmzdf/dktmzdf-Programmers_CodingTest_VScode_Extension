// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { hasUserId } = require('../src/programmers/client');
const { parseLessonUrl, parseLessonPage } = require('../src/programmers/parser');

const FIXTURES = path.join(__dirname, 'fixtures');

/**
 * 로그인 판정 회귀 테스트.
 *
 * 한 번 이것 때문에 제출이 조용히 막혔다: 사이트가 브라우저를 열자마자 발급하는
 * **익명 세션 쿠키**를 로그인 성공으로 착각해 저장했고, 그 쿠키로 채점을 요청하니
 * 서버가 채점 대신 `action: "reload"` 만 돌려줘 화면이 멈춘 채로 있었다.
 *
 * 원인은 "로그인 링크가 없으면 로그인된 것" 이라는 판정이었다. `/learn/challenges`
 * 에는 그 링크가 애초에 없어서 비로그인도 통과했다. 이제는 `data-user-id` 로만 본다.
 *
 * @param {import('./assert').Suite} t
 */
module.exports = function authTests(t) {
  t.section('로그인 판정');

  // --- hasUserId 자체 ---
  t.ok(
    '비로그인: data-user-id 가 빈 값이면 로그인 아님',
    !hasUserId('<script id="__hackle-init-info" data-user-id="" data-business-user=""></script>')
  );
  t.ok(
    '로그인: data-user-id 에 번호가 있으면 로그인',
    hasUserId('<script id="__hackle-init-info" data-user-id="358601" data-business-user=""></script>')
  );
  t.ok(
    '속성이 아예 없으면 로그인 아님',
    !hasUserId('<html><body>아무것도 없음</body></html>')
  );
  t.ok(
    '문제 페이지의 challenge-content 에 붙은 값도 인정한다',
    hasUserId('<div class="challenge-content" data-challengeable-id="17584" data-user-id="358601">')
  );

  // 예전 판정이 왜 안 되는지 못 박아 둔다.
  {
    // `/learn/challenges` 의 비로그인 응답에는 로그인 링크가 없다 (실측 4.5KB 셸).
    const anonymousShell = '<script id="__hackle-init-info" data-user-id="" data-internal-account=""></script>';
    t.ok(
      '비로그인 셸에 로그인 링크가 없어도 로그인으로 착각하지 않는다',
      !/\/account\/sign_in/.test(anonymousShell) && !hasUserId(anonymousShell)
    );
  }

  // --- 픽스처는 전부 비로그인으로 받은 것이다 ---
  t.section('로그인 판정 — 픽스처');
  for (const file of fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.html'))) {
    const id = file.replace('.html', '');
    const { url } = parseLessonUrl(id);
    const problem = parseLessonPage(fs.readFileSync(path.join(FIXTURES, file), 'utf8'), url);
    t.ok(`${id} 은 비로그인으로 판정된다`, problem.loggedIn === false, `loggedIn=${problem.loggedIn}`);
  }
};
