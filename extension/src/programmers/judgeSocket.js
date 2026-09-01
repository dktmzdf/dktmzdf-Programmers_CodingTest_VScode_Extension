// @ts-check
'use strict';

const { ORIGIN } = require('./parser');

/**
 * 프로그래머스의 코드 실행·채점은 전부 ActionCable WebSocket 한 채널로 오간다.
 * REST 제출 엔드포인트는 존재하지 않는다. 프로토콜은 `docs/programmers-api.md` 참고.
 *
 * Node 22+ 의 전역 WebSocket(undici)은 표준에 없는 `headers` 옵션을 받아 준다.
 * 서버가 `Origin` 을 요구하므로 이게 없으면 붙지 못한다 — 확인된 사항이다.
 */

const CHANNEL = 'Challenge::AlgorithmChannel';
const DEFAULT_CABLE = 'wss://ws.programmers.co.kr/cable';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 채점이 이 시간 안에 안 끝나면 포기한다. */
const TIMEOUT_MS = 120000;

/**
 * @typedef {import('./parser').Problem} Problem
 */

/**
 * @typedef {Object} JudgeCase
 * @property {string} name
 * @property {boolean} passed
 * @property {string} msg
 * @property {string} [stdout]
 * @property {string} [stderr]
 */

/**
 * @typedef {Object} Verdict
 * @property {boolean} passed
 * @property {string} summary        한 줄 요약
 * @property {string} detail         result.md 에 남길 마크다운
 * @property {JudgeCase[]} cases
 * @property {string[]} notices      서버가 보낸 안내 메시지
 */

/**
 * 코드를 보내고 채점이 끝날 때까지 기다린다.
 *
 * @param {Object} opts
 * @param {string} opts.cookie
 * @param {Problem} opts.problem
 * @param {string} opts.code
 * @param {'run' | 'submit'} opts.action
 * @param {(text: string) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<Verdict>}
 */
function execute({ cookie, problem, code, action, onProgress, signal }) {
  if (!problem.challengeableId) {
    throw new Error('문제에서 challengeable id를 찾지 못했습니다. 문제를 다시 불러와 주세요.');
  }
  if (!problem.codeId) {
    throw new Error('문제에서 코드 id를 찾지 못했습니다. 문제를 다시 불러와 주세요.');
  }

  const identifier = JSON.stringify({
    channel: CHANNEL,
    challengeable_type: problem.challengeableType,
    challengeable_id: problem.challengeableId,
    language: problem.language,
    lesson_id: problem.lessonId,
  });

  const url = (problem.actionCableUrl || DEFAULT_CABLE).replace(':443/', '/');

  return new Promise((resolve, reject) => {
    /** @type {any[]} */
    const messages = [];
    let settled = false;
    let subscribed = false;

    const ws = new WebSocket(url, {
      headers: {
        Cookie: cookie,
        Origin: ORIGIN,
        'User-Agent': UA,
      },
    });

    const finish = (/** @type {(v: any) => void} */ fn, /** @type {any} */ v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try {
        ws.close();
      } catch {
        /* 이미 닫혔으면 그만이다 */
      }
      fn(v);
    };

    const timer = setTimeout(
      () => finish(reject, new Error(`채점이 ${TIMEOUT_MS / 1000}초 안에 끝나지 않았습니다.`)),
      TIMEOUT_MS
    );

    const onAbort = () => finish(reject, new Error('취소했습니다.'));
    signal?.addEventListener('abort', onAbort, { once: true });

    ws.addEventListener('open', () => {
      onProgress?.('서버에 연결했습니다.');
    });

    ws.addEventListener('error', () => {
      finish(
        reject,
        new Error(
          '채점 서버에 연결하지 못했습니다. 로그인 쿠키가 만료됐을 수 있습니다.'
        )
      );
    });

    ws.addEventListener('close', () => {
      finish(reject, new Error('채점 도중 연결이 끊겼습니다.'));
    });

    ws.addEventListener('message', (ev) => {
      /** @type {any} */
      let frame;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }

      switch (frame.type) {
        case 'ping':
          return;

        // 연결 직후 welcome → 구독
        case 'welcome':
          ws.send(JSON.stringify({ command: 'subscribe', identifier }));
          return;

        case 'confirm_subscription':
          if (subscribed) return; // 재확인 프레임은 무시한다
          subscribed = true;
          onProgress?.(action === 'submit' ? '채점을 요청했습니다.' : '코드 실행을 요청했습니다.');
          ws.send(
            JSON.stringify({
              command: 'message',
              identifier,
              data: JSON.stringify({ codes: { [String(problem.codeId)]: code }, action }),
            })
          );
          return;

        case 'reject_subscription':
          finish(reject, new Error('채점 채널 구독이 거부됐습니다. 로그인 상태를 확인해 주세요.'));
          return;

        case 'disconnect':
          finish(
            reject,
            new Error(
              `채점 서버가 연결을 끊었습니다 (${frame.reason ?? '이유 불명'}). ` +
                '로그인 쿠키를 다시 등록해 보세요.'
            )
          );
          return;

        default:
          break;
      }

      const m = frame.message;
      if (!m || typeof m !== 'object') return;

      messages.push(m);
      if (m.msg) onProgress?.(String(m.msg));

      // run 은 `result`, submit 은 `finish` 로 끝난다.
      const done = action === 'submit' ? m.type === 'finish' : m.type === 'result';
      if (done) finish(resolve, summarize(action, messages, code));
    });
  });
}

/**
 * 받은 프레임들을 사람이 읽는 결과로 바꾼다.
 *
 * @param {'run' | 'submit'} action
 * @param {any[]} messages
 * @param {string} code
 * @returns {Verdict}
 */
function summarize(action, messages, code) {
  /** @type {string[]} */
  const notices = [];
  /** @type {JudgeCase[]} */
  const cases = [];
  /** @type {any} */
  let final = null;
  /** @type {any} */
  let group = null;

  for (const m of messages) {
    switch (m.type) {
      case 'start':
        if (m.msg) notices.push(String(m.msg));
        break;
      case 'error':
        // 치명적 오류가 아니라 안내인 경우가 많다 ("같은 코드로 채점한 결과가 있습니다").
        if (m.msg) notices.push(String(m.msg));
        break;
      case 'test_group':
        group = m;
        break;
      case 'testcase':
        cases.push({
          name:
            action === 'submit'
              ? `테스트 ${cases.length + 1}`
              : `예제 ${(Number(m.index) || 0) + 1}`,
          passed: Boolean(m.passed),
          msg: String(m.msg ?? ''),
          stdout: m.stdout == null ? undefined : String(m.stdout),
          stderr: m.stderr == null ? undefined : String(m.stderr),
        });
        break;
      case 'result':
      case 'result_lesson_challenge':
        final = m;
        break;
      default:
        break;
    }
  }

  const passedCount = cases.filter((c) => c.passed).length;
  const total = cases.length;
  const passed = final ? Boolean(final.passed) : total > 0 && passedCount === total;

  const label = action === 'submit' ? '채점' : '코드 실행';
  const summary = `${label} ${passed ? '성공' : '실패'} — ${total}개 중 ${passedCount}개 통과`;

  /** @type {string[]} */
  const detail = [`**${summary}**`, ''];

  if (group?.msg) detail.push(`분류: ${String(group.msg).trim()}`, '');

  if (cases.length > 0) {
    detail.push('| 테스트 | 결과 |', '| --- | --- |');
    for (const c of cases) {
      detail.push(`| ${c.name} | ${c.passed ? '✅' : '❌'} ${c.msg || (c.passed ? '통과' : '실패')} |`);
    }
    detail.push('');
  }

  if (final && final.userScore != null) {
    detail.push(`점수: ${final.userScore} / ${final.perfectScore}`, '');
  }
  for (const n of notices) detail.push(`> ${n}`);
  if (notices.length) detail.push('');

  detail.push('제출한 코드:', '', '```python', code.trim(), '```');

  return { passed, summary, detail: detail.join('\n'), cases, notices };
}

module.exports = { execute, CHANNEL, DEFAULT_CABLE };
