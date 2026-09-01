// @ts-check
'use strict';

const { ORIGIN, parseLessonUrl, parseLessonPage } = require('./parser');
const judge = require('./judgeSocket');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 프로그래머스 스쿨과 통신한다.
 *
 * 공개 API가 없어서 브라우저가 쓰는 것과 같은 요청을 흉내낸다.
 * 본인 계정으로 본인 코드를 다루는 용도이며, 사용자가 버튼을 누를 때만 호출한다.
 */
class ProgrammersClient {
  /** @param {import('../auth').Auth} auth */
  constructor(auth) {
    /** @private */
    this._auth = auth;
  }

  /**
   * 문제 페이지를 받아 파싱한다. 로그인 없이도 동작한다.
   * @param {string} urlOrId
   * @returns {Promise<import('./parser').Problem>}
   */
  async fetchProblem(urlOrId) {
    const { url } = parseLessonUrl(urlOrId);
    const res = await this._get(url);

    if (res.status === 404) throw new Error(`문제를 찾을 수 없습니다 (404): ${url}`);
    if (!res.ok) throw new Error(`문제 페이지를 받지 못했습니다 (HTTP ${res.status}).`);

    return parseLessonPage(await res.text(), url);
  }

  /**
   * 저장된 쿠키가 아직 살아 있는지 확인한다.
   * @returns {Promise<{ ok: boolean, reason?: string }>}
   */
  async checkAuth() {
    const cookie = await this._auth.getCookie();
    if (!cookie) return { ok: false, reason: '등록된 쿠키가 없습니다.' };

    const res = await this._get(`${ORIGIN}/learn/challenges`, { redirect: 'manual' });

    if (res.status >= 300 && res.status < 400) {
      const to = res.headers.get('location') ?? '';
      if (/sign_in|login/i.test(to)) {
        return { ok: false, reason: '세션이 만료되었습니다. 쿠키를 다시 등록해 주세요.' };
      }
    }
    if (!res.ok && res.status !== 0) {
      return { ok: false, reason: `확인 요청이 실패했습니다 (HTTP ${res.status}).` };
    }

    const html = await res.text().catch(() => '');
    if (/\/account\/sign_in\?referer/.test(html)) {
      return { ok: false, reason: '세션이 만료되었습니다. 쿠키를 다시 등록해 주세요.' };
    }
    return { ok: true };
  }

  /**
   * 코드를 제출하고 채점 결과를 돌려준다. (사이트의 [제출 후 채점하기])
   *
   * @param {Object} opts
   * @param {import('./parser').Problem} opts.problem
   * @param {string} opts.code
   * @param {(text: string) => void} [opts.onProgress]
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<import('./judgeSocket').Verdict>}
   */
  async submit(opts) {
    return await this._judge('submit', opts);
  }

  /**
   * 사이트에서 예제만 돌려 본다. (사이트의 [코드 실행]) 제출 기록은 남지 않는다.
   *
   * @param {Object} opts
   * @param {import('./parser').Problem} opts.problem
   * @param {string} opts.code
   * @param {(text: string) => void} [opts.onProgress]
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<import('./judgeSocket').Verdict>}
   */
  async runRemote(opts) {
    return await this._judge('run', opts);
  }

  /**
   * @private
   * @param {'run' | 'submit'} action
   * @param {{ problem: import('./parser').Problem, code: string,
   *           onProgress?: (t: string) => void, signal?: AbortSignal }} opts
   * @returns {Promise<import('./judgeSocket').Verdict>}
   */
  async _judge(action, opts) {
    const cookie = await this._auth.getCookie();
    if (!cookie) throw new Error('로그인 쿠키가 없습니다. 먼저 쿠키를 등록해 주세요.');

    return await judge.execute({
      cookie,
      problem: opts.problem,
      code: opts.code,
      action,
      onProgress: opts.onProgress,
      signal: opts.signal,
    });
  }

  /**
   * @private
   * @param {string} url
   * @param {{ redirect?: RequestRedirect }} [opts]
   * @returns {Promise<Response>}
   */
  async _get(url, opts = {}) {
    return await fetch(url, {
      method: 'GET',
      redirect: opts.redirect ?? 'follow',
      headers: await this._headers(url),
    });
  }

  /**
   * @private
   * @param {string} referer
   * @returns {Promise<Record<string, string>>}
   */
  async _headers(referer) {
    /** @type {Record<string, string>} */
    const h = {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      'Referer': referer,
    };
    const cookie = await this._auth.getCookie();
    if (cookie) h['Cookie'] = cookie;
    return h;
  }
}

module.exports = { ProgrammersClient, ORIGIN };
