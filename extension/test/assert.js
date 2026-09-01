// @ts-check
'use strict';

/**
 * 의존성 없는 미니 테스트 도구.
 * 테스트 프레임워크를 넣지 않는 이유는 확장 자체가 의존성 0개이기 때문이다.
 */

class Suite {
  /** @param {(line?: string) => void} log */
  constructor(log) {
    this.log = log;
    this.passed = 0;
    this.failed = 0;
    this.skipped = 0;
    /** @type {string[]} */
    this.failures = [];
  }

  /** @param {string} name */
  section(name) {
    this.log('');
    this.log(`── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}`);
  }

  /**
   * @param {string} label
   * @param {unknown} cond
   * @param {string} [detail] 실패했을 때 덧붙일 설명
   */
  ok(label, cond, detail) {
    if (cond) {
      this.passed++;
      this.log(`  PASS  ${label}`);
      return true;
    }
    this.failed++;
    this.failures.push(label);
    this.log(`  FAIL  ${label}`);
    if (detail) this.log(`        ${detail}`);
    return false;
  }

  /**
   * @param {string} label
   * @param {unknown} actual
   * @param {unknown} expected
   */
  eq(label, actual, expected) {
    if (deepEqual(actual, expected)) {
      this.passed++;
      this.log(`  PASS  ${label}`);
      return true;
    }
    this.failed++;
    this.failures.push(label);
    this.log(`  FAIL  ${label}`);
    this.log(`        기대: ${show(expected)}`);
    this.log(`        실제: ${show(actual)}`);
    return false;
  }

  /**
   * @param {string} label
   * @param {string} why
   */
  skip(label, why) {
    this.skipped++;
    this.log(`  SKIP  ${label} — ${why}`);
  }

  summary() {
    this.log('');
    this.log('='.repeat(64));
    this.log(`통과 ${this.passed} · 실패 ${this.failed} · 건너뜀 ${this.skipped}`);
    if (this.failed > 0) {
      this.log('');
      this.log('실패한 항목:');
      for (const f of this.failures) this.log(`  - ${f}`);
    }
    // run.ps1 이 이 줄을 보고 끝난 걸 안다.
    this.log(`=== DONE ${this.failed === 0 ? 'PASS' : 'FAIL'} ===`);
  }
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every((k) => deepEqual(/** @type {any} */ (a)[k], /** @type {any} */ (b)[k]))
    );
  }
  return false;
}

/**
 * @param {unknown} v
 * @returns {string}
 */
function show(v) {
  let s;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s === undefined) s = String(v);
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

module.exports = { Suite, deepEqual, show };
