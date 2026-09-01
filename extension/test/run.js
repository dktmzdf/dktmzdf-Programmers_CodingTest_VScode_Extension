// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Suite } = require('./assert');

/**
 * 테스트 진입점.
 *
 * VS Code 내장 Node로 돌린다 (`run.ps1` 참고). 그런데 Electron의 node 모드는
 * **비동기 구간의 stdout을 흘려버린다.** 그래서 결과를 파일에도 계속 쓰고,
 * `run.ps1` 이 그 파일을 읽어 보여 준다.
 */

const OUT = path.join(__dirname, 'last-run.txt');

/** @type {string[]} */
const lines = [];

/** @param {string} [line] */
function log(line) {
  const text = line == null ? '' : String(line);
  lines.push(text);
  console.log(text);
  fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
}

const suite = new Suite(log);

// Electron의 node 모드가 이벤트 루프를 비었다고 보고 일찍 끝내는 걸 막는다.
const keepAlive = setInterval(() => {}, 500);

(async () => {
  log('코딩테스트 에이전트 — 테스트');
  log(`node ${process.version}`);

  require('./syntax.test')(suite);
  require('./markdown.test')(suite);
  require('./parser.test')(suite);
  require('./browser-login.test')(suite);
  await require('./runner.test')(suite);

  suite.summary();
})()
  .catch((e) => {
    log('');
    log('테스트 실행 중 예외:');
    log(e && e.stack ? e.stack : String(e));
    suite.failed++;
    suite.summary();
  })
  .finally(() => {
    clearInterval(keepAlive);
    process.exitCode = suite.failed > 0 ? 1 : 0;
  });
