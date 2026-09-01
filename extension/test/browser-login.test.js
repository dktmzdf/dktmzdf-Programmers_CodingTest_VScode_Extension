// @ts-check
'use strict';

const path = require('node:path');
const { browserCandidates, cookieHeader, isProgrammersDomain } = require('../src/browserLogin');

/** @param {import('./assert').Suite} t */
module.exports = function browserLoginTests(t) {
  t.section('브라우저 자동 로그인');

  const env = {
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  };
  const custom = 'D:\\Apps\\Chrome\\chrome.exe';
  const candidates = browserCandidates(custom, env);
  t.eq('사용자 지정 경로가 최우선', candidates[0], path.resolve(custom));
  t.ok('Chrome을 Edge보다 먼저 탐색',
    candidates.findIndex((p) => /Google[\\/]Chrome/.test(p)) <
      candidates.findIndex((p) => /Microsoft[\\/]Edge/.test(p)));

  t.ok('상위 도메인 허용', isProgrammersDomain('.programmers.co.kr'));
  t.ok('학교 서브도메인 허용', isProgrammersDomain('school.programmers.co.kr'));
  t.ok('닮은 외부 도메인 차단', !isProgrammersDomain('programmers.co.kr.example.com'));

  const header = cookieHeader([
    { name: '_program_us_session', value: 'secret', domain: '.programmers.co.kr' },
    { name: 'school', value: 'yes', domain: 'school.programmers.co.kr' },
    { name: 'external', value: 'no', domain: 'example.com' },
    { name: 'bad', value: 'x\r\nInjected: yes', domain: '.programmers.co.kr' },
  ]);
  t.ok('프로그래머스 쿠키만 직렬화',
    header.includes('_program_us_session=secret') &&
      header.includes('school=yes') &&
      !header.includes('external') &&
      !header.includes('Injected'));
};
