// @ts-check
'use strict';

const SECRET_KEY = 'codingTest.programmersCookie';

/**
 * 프로그래머스 세션 쿠키를 VS Code SecretStorage에만 보관한다.
 * 파일·로그·설정 어디에도 쓰지 않는다.
 */
class Auth {
  /** @param {import('vscode').SecretStorage} secrets */
  constructor(secrets) {
    /** @private */
    this._secrets = secrets;
  }

  /** @returns {Promise<string | undefined>} */
  async getCookie() {
    return await this._secrets.get(SECRET_KEY);
  }

  /** @returns {Promise<boolean>} */
  async hasCookie() {
    return Boolean(await this.getCookie());
  }

  /**
   * @param {string} raw 붙여넣은 값
   * @returns {Promise<void>}
   */
  async setCookie(raw) {
    const cleaned = normalizeCookie(raw);
    const problem = validateCookie(cleaned);
    if (problem) throw new Error(problem);
    await this._secrets.store(SECRET_KEY, cleaned);
  }

  /** @returns {Promise<void>} */
  async clearCookie() {
    await this._secrets.delete(SECRET_KEY);
  }
}

/**
 * 개발자도구에서 복사한 값이 여러 모양으로 들어온다:
 *   `Cookie: a=1; b=2`  /  `a=1; b=2`  /  세션 쿠키 값만
 * 마지막 경우는 이름을 붙여 준다.
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizeCookie(raw) {
  let s = raw.trim().replace(/^cookie\s*:\s*/i, '').trim();
  s = s.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ');
  if (!s) return '';
  return s;
}

/**
 * 붙여넣은 값이 쿠키 헤더 모양인지 본다.
 *
 * 세션 쿠키의 **이름**은 로그인해야 생기고 사이트가 바꿀 수도 있어서 우리가 넘겨짚지
 * 않는다. `이름=값` 쌍이 하나라도 있어야 받는다 — 그래서 Network 탭의 `Cookie`
 * 헤더를 통째로 붙여넣는 방법을 안내한다.
 *
 * @param {string} cookie
 * @returns {string | null} 문제가 있으면 사람이 읽을 이유, 괜찮으면 null
 */
function validateCookie(cookie) {
  if (!cookie) return '아무것도 입력되지 않았습니다.';
  if (!cookie.includes('=')) {
    return (
      '쿠키 형식이 아닙니다. 값 하나만 복사하지 말고 `이름=값; 이름=값` 형태의 ' +
      'Cookie 헤더를 통째로 붙여넣어 주세요.'
    );
  }
  if (cookie.length < 20) return '쿠키가 너무 짧습니다. 전체를 복사했는지 확인해 주세요.';
  return null;
}

module.exports = { Auth, normalizeCookie, validateCookie, SECRET_KEY };
