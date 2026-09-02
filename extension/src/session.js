// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('node:path');

const { ProgrammersClient } = require('./programmers/client');
const ws = require('./workspace');
const testgen = require('./testgen');
const { runAll } = require('./runner');
const { explain, KINDS } = require('./explain');

/**
 * @typedef {import('./programmers/parser').Problem} Problem
 * @typedef {import('./programmers/parser').TestCase} TestCase
 * @typedef {import('./runner').CaseResult} CaseResult
 * @typedef {import('./explain').ExplainKind} ExplainKind
 */

/**
 * @typedef {Object} SessionState
 * @property {Problem | null} problem
 * @property {string | null} dir
 * @property {TestCase[]} cases
 * @property {CaseResult[] | null} results
 * @property {{ ok: boolean, reason?: string }} auth
 * @property {string | null} busy  진행 중인 작업 라벨
 * @property {{ label: string, text: string, ms: number, costUsd: number | null } | null} explanation
 * @property {import('./programmers/judgeSocket').Verdict | null} submitResult
 * @property {TestCase[] | null} proposals  클로드가 제안한, 아직 담지 않은 케이스
 * @property {string | null} error
 * @property {string | null} notice
 */

/**
 * 확장의 상태 한 벌과 그 위에서 도는 동작들.
 * 뷰(웹뷰)는 이 상태를 그리기만 하고, 로직은 전부 여기 있다.
 */
class Session {
  /**
   * @param {import('./auth').Auth} auth
   */
  constructor(auth) {
    /** @private */
    this._auth = auth;
    /** @private */
    this._client = new ProgrammersClient(auth);
    /** @private @type {vscode.EventEmitter<SessionState>} */
    this._emitter = new vscode.EventEmitter();
    /** @private @type {AbortController | null} */
    this._abort = null;

    /** @type {SessionState} */
    this.state = {
      problem: null,
      dir: null,
      cases: [],
      results: null,
      auth: { ok: false, reason: '아직 확인하지 않았습니다.' },
      busy: null,
      explanation: null,
      submitResult: null,
      proposals: null,
      error: null,
      notice: null,
    };
  }

  /** 상태가 바뀔 때마다 발생한다. */
  get onDidChange() {
    return this._emitter.event;
  }

  /**
   * @param {Partial<SessionState>} patch
   * @returns {void}
   */
  update(patch) {
    this.state = { ...this.state, ...patch };
    this._emitter.fire(this.state);
  }

  /** 진행 중인 작업을 취소한다. */
  cancel() {
    this._abort?.abort();
    this._abort = null;
    this.update({ busy: null });
  }

  /**
   * @private
   * @template T
   * @param {string} label
   * @param {(signal: AbortSignal) => Promise<T>} fn
   * @returns {Promise<T | undefined>}
   */
  async _withBusy(label, fn) {
    if (this.state.busy) {
      this.update({ error: `${this.state.busy} 작업이 끝나야 합니다.` });
      return undefined;
    }
    const ac = new AbortController();
    this._abort = ac;
    this.update({ busy: label, error: null, notice: null });
    try {
      return await fn(ac.signal);
    } catch (e) {
      this.update({ error: e instanceof Error ? e.message : String(e) });
      return undefined;
    } finally {
      if (this._abort === ac) this._abort = null;
      this.update({ busy: null });
    }
  }

  // ---------------------------------------------------------------- 문제

  /**
   * 문제를 받아 파일로 저장하고 solution.py 를 연다.
   * @param {string} urlOrId
   * @returns {Promise<void>}
   */
  async loadProblem(urlOrId) {
    await this._withBusy('문제 불러오는 중', async () => {
      const problem = await this._client.fetchProblem(urlOrId);
      const saved = await ws.saveProblem(problem);

      // 예제를 못 읽어도 막지 않는다 — 문제는 읽히고 제출도 되므로,
      // 케이스는 직접 추가해서 쓰면 된다.
      const folder = path.basename(saved.dir);
      const notice =
        saved.cases.length === 0
          ? `${folder} 폴더를 만들었습니다. 입출력 예를 자동으로 읽지 못했으니 테스트 케이스를 직접 추가해 주세요.`
          : saved.solutionCreated
            ? `${folder} 폴더를 만들었습니다.`
            : `${folder} 폴더를 갱신했습니다. solution.py 는 그대로 뒀습니다.`;

      this.update({
        problem,
        dir: saved.dir,
        cases: saved.cases,
        results: null,
        explanation: null,
        submitResult: null,
        proposals: null,
        notice,
      });

      const doc = await vscode.workspace.openTextDocument(saved.solutionPath);
      await vscode.window.showTextDocument(doc, { preview: false });
    });
  }

  // ---------------------------------------------------------------- 테스트

  /**
   * 로컬에서 테스트 케이스를 돌린다.
   * @returns {Promise<void>}
   */
  async runLocal() {
    const { dir, cases, problem } = this.state;
    if (!dir || !problem) {
      this.update({ error: '먼저 문제를 불러와 주세요.' });
      return;
    }
    if (cases.length === 0) {
      this.update({ error: '실행할 테스트 케이스가 없습니다.' });
      return;
    }

    await this._withBusy('테스트 실행 중', async (signal) => {
      await this._saveOpenSolution(dir);

      /** @type {CaseResult[]} */
      const partial = [];
      // 코드를 다시 돌리는 순간 이전 채점 결과는 더 이상 이 코드의 것이 아니다.
      this.update({ results: partial, submitResult: null });

      const results = await runAll({
        solutionPath: path.join(dir, 'solution.py'),
        cases,
        type: problem.type,
        signature: problem.signature,
        signal,
        onResult: (r) => {
          partial.push(r);
          this.update({ results: [...partial] });
        },
      });
      this.update({ results });
    });
  }

  /**
   * solution.py 가 편집 중이면 저장하고 나서 실행해야 한다.
   * @private
   * @param {string} dir
   * @returns {Promise<void>}
   */
  async _saveOpenSolution(dir) {
    const target = path.join(dir, 'solution.py').toLowerCase();
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.isDirty && doc.uri.fsPath.toLowerCase() === target) {
        await doc.save();
      }
    }
  }

  // -------------------------------------------------- 케이스 생성 (클로드)

  /**
   * 클로드에게 엣지 케이스를 만들게 한다. 바로 저장하지 않고 제안 목록에만 담는다 —
   * 기대값을 클로드가 계산하므로 틀릴 수 있어, 사람이 보고 고른 뒤 담는다.
   *
   * @returns {Promise<void>}
   */
  async generateCases() {
    const { problem, dir, cases } = this.state;
    if (!problem || !dir) {
      this.update({ error: '먼저 문제를 불러와 주세요.' });
      return;
    }

    await this._withBusy('테스트 케이스 만드는 중', async (signal) => {
      const res = await testgen.generate({ problem, existing: cases, signal });
      const cost = res.costUsd === null ? '' : ` · $${res.costUsd.toFixed(3)}`;
      this.update({
        proposals: res.cases,
        notice: `${res.cases.length}개를 제안했습니다. 확인하고 담아 주세요. (${(res.ms / 1000).toFixed(1)}초${cost})`,
      });
    });
  }

  /**
   * 제안 하나를 실제 케이스로 담는다.
   * @param {number} index
   * @returns {Promise<void>}
   */
  async acceptProposal(index) {
    const proposals = this.state.proposals;
    const picked = proposals?.[index];
    if (!proposals || !picked) return;

    await this._mutateCases((cases) => {
      cases.push(picked);
      return cases;
    });
    this.update({ proposals: proposals.filter((_, i) => i !== index) });
  }

  /** @returns {Promise<void>} */
  async acceptAllProposals() {
    const proposals = this.state.proposals;
    if (!proposals || proposals.length === 0) return;

    await this._mutateCases((cases) => {
      cases.push(...proposals);
      return cases;
    });
    this.update({ proposals: null, notice: `제안 ${proposals.length}개를 모두 담았습니다.` });
  }

  /** 제안을 버린다. 담지 않은 것은 저장되지 않는다. */
  dismissProposals() {
    this.update({ proposals: null });
  }

  // ------------------------------------------------------------ 케이스 편집

  /**
   * 케이스 하나의 내용. 문제 형식에 따라 `input` 이나 `args` 중 하나가 온다.
   * @typedef {{ input?: string, args?: string[], expected: string }} CaseDraft
   */

  /**
   * @param {CaseDraft} draft
   * @returns {Promise<void>}
   */
  async addCase(draft) {
    await this._mutateCases((cases) => {
      const n = cases.filter((c) => c.source === 'user').length + 1;
      cases.push({ name: `내 케이스 ${n}`, source: 'user', ...this._shape(draft) });
      return cases;
    });
  }

  /**
   * @param {number} index
   * @param {CaseDraft} draft
   * @returns {Promise<void>}
   */
  async updateCase(index, draft) {
    await this._mutateCases((cases) => {
      const c = cases[index];
      if (!c) throw new Error('없는 테스트 케이스입니다.');
      if (c.source === 'official') throw new Error('공식 예제는 수정할 수 없습니다.');
      // 클로드가 제안한 케이스도 고칠 수 있어야 한다 — 기대값이 틀렸을 수 있으므로.
      cases[index] = { name: c.name, source: c.source, ...this._shape(draft) };
      return cases;
    });
  }

  /**
   * 현재 문제 형식에 맞는 케이스 모양으로 다듬는다.
   * @private
   * @param {CaseDraft} draft
   * @returns {{ expected: string, input?: string, args?: string[] }}
   */
  _shape(draft) {
    const expected = draft.expected ?? '';
    if (this.state.problem?.type === 'function') {
      const want = this.state.problem.signature.length;
      const args = (draft.args ?? []).map((a) => String(a).trim());
      if (want > 0 && args.length !== want) {
        throw new Error(`인자를 ${want}개 채워 주세요.`);
      }
      if (args.some((a) => !a)) throw new Error('비어 있는 인자가 있습니다.');
      return { args, expected: expected.trim() };
    }
    return { input: draft.input ?? '', expected };
  }

  /**
   * @param {number} index
   * @returns {Promise<void>}
   */
  async deleteCase(index) {
    await this._mutateCases((cases) => {
      if (!cases[index]) throw new Error('없는 테스트 케이스입니다.');
      cases.splice(index, 1);
      return cases;
    });
  }

  /**
   * @private
   * @param {(cases: TestCase[]) => TestCase[]} fn
   * @returns {Promise<void>}
   */
  async _mutateCases(fn) {
    const { dir, problem } = this.state;
    if (!dir || !problem) {
      this.update({ error: '먼저 문제를 불러와 주세요.' });
      return;
    }
    try {
      const cases = fn([...this.state.cases]);
      const type = problem.type === 'function' ? 'function' : 'stdio';
      await ws.saveTestcases(dir, {
        lessonId: problem.lessonId,
        title: problem.title,
        type,
        ...(type === 'function' ? { signature: problem.signature } : {}),
        cases,
      });
      // 케이스 구성이 바뀌면 이전 결과는 더 이상 대응되지 않는다.
      this.update({ cases, results: null, error: null });
    } catch (e) {
      this.update({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ---------------------------------------------------------------- 해설

  /**
   * @param {ExplainKind} kind
   * @returns {Promise<void>}
   */
  async explainProblem(kind) {
    const { problem, dir } = this.state;
    if (!problem || !dir) {
      this.update({ error: '먼저 문제를 불러와 주세요.' });
      return;
    }

    await this._withBusy(`${KINDS[kind].label} 받는 중`, async (signal) => {
      const code = await ws.readSolution(dir).catch(() => '');
      const res = await explain({
        kind,
        problem,
        code,
        results: this.state.results ?? undefined,
        signal,
      });

      const file = await ws.appendSection(dir, 'explanation.md', KINDS[kind].label, res.text);
      this.update({
        explanation: { label: KINDS[kind].label, text: res.text, ms: res.ms, costUsd: res.costUsd },
        notice: `${path.basename(file)} 에 기록했습니다.`,
      });
    });
  }

  // ---------------------------------------------------------------- 제출

  /**
   * 프로그래머스에 코드를 제출하고 채점 결과를 받는다.
   * @returns {Promise<void>}
   */
  async submit() {
    const { dir, problem } = this.state;
    if (!dir || !problem) {
      this.update({ error: '먼저 문제를 불러와 주세요.' });
      return;
    }

    await this.refreshAuth();
    if (!this.state.auth.ok) {
      this.update({ error: `로그인이 필요합니다 — ${this.state.auth.reason ?? ''}` });
      return;
    }

    const answer = await vscode.window.showWarningMessage(
      `"${problem.title}" 을(를) 제출할까요? 프로그래머스 제출 내역에 그대로 남습니다.`,
      { modal: true },
      '제출'
    );
    if (answer !== '제출') return;

    await this._withBusy('제출·채점 중', async (signal) => {
      await this._saveOpenSolution(dir);
      const code = await ws.readSolution(dir);

      const verdict = await this._client.submit({
        problem,
        code,
        signal,
        onProgress: (text) => this.update({ busy: `제출·채점 중 — ${text}` }),
      });

      const file = await ws.appendSection(dir, 'result.md', verdict.summary, verdict.detail);
      this.update({
        submitResult: verdict,
        notice: `${verdict.summary} — ${path.basename(file)} 에 기록했습니다.`,
      });
    });
  }

  // ---------------------------------------------------------------- 인증

  /** @returns {Promise<void>} */
  async refreshAuth() {
    if (!(await this._auth.hasCookie())) {
      this.update({ auth: { ok: false, reason: '등록된 쿠키가 없습니다.' } });
      return;
    }
    try {
      this.update({ auth: await this._client.checkAuth() });
    } catch (e) {
      this.update({ auth: { ok: false, reason: e instanceof Error ? e.message : String(e) } });
    }
  }

  /** @returns {Promise<void>} */
  async promptForCookie() {
    const value = await vscode.window.showInputBox({
      title: '프로그래머스 로그인 쿠키 등록',
      prompt:
        'F12 → Network 탭 → F5 → 문제 페이지 요청 → Request Headers의 cookie: 값을 통째로 붙여넣으세요.',
      placeHolder: 'a=1; b=2; c=3  (세미콜론으로 이어진 줄 전체)',
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) return;

    try {
      await this._auth.setCookie(value);
    } catch (e) {
      this.update({ error: e instanceof Error ? e.message : String(e) });
      return;
    }
    await this.refreshAuth();
    this.update({
      notice: this.state.auth.ok ? '로그인 확인됐습니다.' : null,
      error: this.state.auth.ok ? null : this.state.auth.reason ?? '쿠키 확인에 실패했습니다.',
    });
  }

  /** @returns {Promise<void>} */
  async clearCookie() {
    await this._auth.clearCookie();
    this.update({ auth: { ok: false, reason: '쿠키를 삭제했습니다.' }, notice: '쿠키를 삭제했습니다.' });
  }

  // 자동 로그인 버전의 명령 ID를 위한 호환 별칭.
  async login() { await this.promptForCookie(); }
  async logout() { await this.clearCookie(); }

  dispose() {
    this._abort?.abort();
    this._emitter.dispose();
  }
}

module.exports = { Session };
