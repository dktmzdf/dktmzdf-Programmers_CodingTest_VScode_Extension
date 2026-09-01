// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

/** 소스에 섞이면 안 되는 제어문자. 이스케이프로만 적는다 — 여기에 진짜
 *  제어문자를 넣으면 이 검사 자체가 오염된다. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

/**
 * 빌드 단계가 없으니 문법 오류는 확장을 켜 봐야 드러난다.
 * 그 전에 여기서 잡는다.
 *
 * @param {import('./assert').Suite} t
 */
module.exports = function syntaxTests(t) {
  t.section('구문 검사');

  let checked = 0;
  let bad = 0;

  /** @param {string} dir */
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'fixtures') continue;

      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }

      const rel = path.relative(ROOT, full).replace(/\\/g, '/');
      const src = fs.readFileSync(full, 'utf8');

      if (entry.name.endsWith('.js')) {
        checked++;
        try {
          new vm.Script(src, { filename: full });
        } catch (e) {
          bad++;
          t.ok(rel, false, e instanceof Error ? e.message : String(e));
        }
      } else if (entry.name.endsWith('.json')) {
        checked++;
        try {
          JSON.parse(src);
        } catch (e) {
          bad++;
          t.ok(rel, false, e instanceof Error ? e.message : String(e));
        }
      }
    }
  })(ROOT);

  t.ok(`${checked}개 파일 파싱`, bad === 0, `${bad}개 실패`);

  // 소스에 제어문자가 들어가면 편집기·도구가 조용히 망가뜨린다. (한 번 겪었다)
  t.section('제어문자 검사');
  /** @type {string[]} */
  const dirty = [];
  (function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'fixtures') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full);
      } else if (/\.(js|json|css|py|md)$/.test(entry.name)) {
        const c = fs.readFileSync(full, 'utf8');
        if (CONTROL_CHARS.test(c)) {
          dirty.push(path.relative(ROOT, full).replace(/\\/g, '/'));
        }
      }
    }
  })(ROOT);

  t.ok('소스에 제어문자 없음', dirty.length === 0, dirty.join(', '));
};
