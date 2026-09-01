// @ts-check
/* 웹뷰 쪽 스크립트. DOM만 만들고, 실제 동작은 전부 확장 호스트에 메시지로 넘긴다. */
'use strict';

(function () {
  // @ts-ignore - 웹뷰 런타임이 주입한다. 테스트로 Node에서 불러올 때는 없다.
  const vscode =
    typeof acquireVsCodeApi === 'function'
      ? acquireVsCodeApi()
      : { postMessage() {}, getState() {}, setState() {} };

  const STATUS = {
    pass: { icon: '✅', label: '통과' },
    fail: { icon: '❌', label: '틀림' },
    error: { icon: '⚠️', label: '실행 오류' },
    timeout: { icon: '⏱️', label: '시간 초과' },
  };

  const EXPLAIN_BUTTONS = [
    { kind: 'hint', label: '💡 힌트' },
    { kind: 'approach', label: '🗺️ 접근법' },
    { kind: 'full', label: '📖 전체 해설' },
    { kind: 'diagnose', label: '🔍 코드 진단' },
  ];

  /** @type {any} */
  let state = null;

  /** 웹뷰가 숨겨졌다 돌아와도 입력 중이던 내용이 남도록 따로 보관한다. */
  const draft = Object.assign(
    { url: '', showAdd: false, newInput: '', newArgs: [], newExpected: '', editIndex: null, open: {} },
    vscode.getState() || {}
  );
  if (!Array.isArray(draft.newArgs)) draft.newArgs = [];

  function saveDraft() {
    vscode.setState(draft);
  }

  // ------------------------------------------------------------------ 유틸

  /**
   * @param {string} s
   * @returns {string}
   */
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 아주 작은 마크다운 렌더러. 먼저 이스케이프한 뒤 변환하므로 주입 위험이 없다.
   * @param {string} md
   * @returns {string}
   */
  function renderMarkdown(md) {
    /** @type {string[]} */
    const blocks = [];
    let s = esc(md).replace(/\r\n/g, '\n');

    s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, body) => {
      const i = blocks.push(`<pre><code>${body.replace(/\n$/, '')}</code></pre>`) - 1;
      return '@@CB' + i + '@@';
    });

    s = s
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

    const out = [];
    /** @type {string[] | null} */
    let list = null;
    /** @type {string|null} */
    let listTag = null;

    const flush = () => {
      if (list && listTag) out.push(`<${listTag}>${list.join('')}</${listTag}>`);
      list = null;
      listTag = null;
    };

    for (const raw of s.split('\n')) {
      const line = raw.trim();
      if (!line) { flush(); continue; }

      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flush(); const lv = Math.min(6, Math.max(3, h[1].length)); out.push(`<h${lv}>${h[2]}</h${lv}>`); continue; }

      const ul = line.match(/^[-*+]\s+(.*)$/);
      if (ul) { if (listTag !== 'ul') { flush(); list = []; listTag = 'ul'; } list.push(`<li>${ul[1]}</li>`); continue; }

      const ol = line.match(/^\d+[.)]\s+(.*)$/);
      if (ol) { if (listTag !== 'ol') { flush(); list = []; listTag = 'ol'; } list.push(`<li>${ol[1]}</li>`); continue; }

      if (/^@@CB\d+@@$/.test(line)) { flush(); out.push(line); continue; }
      if (/^(-{3,}|_{3,})$/.test(line)) { flush(); out.push('<hr>'); continue; }

      flush();
      out.push(`<p>${line}</p>`);
    }
    flush();

    return out.join('').replace(/@@CB(\d+)@@/g, (_, i) => blocks[Number(i)] || '');
  }

  /**
   * @param {string} html
   * @returns {HTMLElement}
   */
  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return /** @type {HTMLElement} */ (t.content.firstElementChild);
  }

  /**
   * @param {string} type
   * @param {Record<string, unknown>} [extra]
   */
  function send(type, extra) {
    vscode.postMessage(Object.assign({ type }, extra || {}));
  }

  // ------------------------------------------------------------------ 렌더

  function render() {
    const app = document.getElementById('app');
    if (!app) return;
    app.innerHTML = '';

    app.appendChild(renderToolbar());

    if (state?.busy) app.appendChild(renderBusy());
    if (state?.error) app.appendChild(banner('error', state.error));
    if (state?.notice && !state.error) app.appendChild(banner('notice', state.notice));

    if (!state?.problem) {
      app.appendChild(el(`<div class="empty-hint">
        위에 프로그래머스 문제 URL을 붙여넣고 <b>불러오기</b>를 누르세요.<br><br>
        예: school.programmers.co.kr/learn/courses/30/lessons/181950
      </div>`));
      return;
    }

    app.appendChild(renderProblem());
    app.appendChild(renderCases());
    app.appendChild(renderActions());
    if (state.submitResult) app.appendChild(renderSubmitResult());
    if (state.explanation) app.appendChild(renderExplanation());
  }

  function renderToolbar() {
    const wrap = el(`<section>
      <div class="row">
        <div class="grow"><input type="text" id="url" placeholder="문제 URL 또는 문제 번호" /></div>
        <button id="load">불러오기</button>
      </div>
    </section>`);

    const input = /** @type {HTMLInputElement} */ (wrap.querySelector('#url'));
    input.value = draft.url;
    input.addEventListener('input', () => { draft.url = input.value; saveDraft(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
    wrap.querySelector('#load')?.addEventListener('click', load);

    const btn = /** @type {HTMLButtonElement} */ (wrap.querySelector('#load'));
    btn.disabled = Boolean(state?.busy);

    function load() {
      if (!draft.url.trim()) return;
      send('load', { url: draft.url.trim() });
    }
    return wrap;
  }

  function renderBusy() {
    const b = el(`<div class="banner notice">
      <span class="spinner"></span><span id="busy-label"></span>
      <div class="row"><button class="link" id="cancel">취소</button></div>
    </div>`);
    const label = b.querySelector('#busy-label');
    if (label) label.textContent = state.busy;
    b.querySelector('#cancel')?.addEventListener('click', () => send('cancel'));
    return b;
  }

  /**
   * @param {string} kind
   * @param {string} text
   */
  function banner(kind, text) {
    const b = el(`<div class="banner ${kind}"></div>`);
    b.textContent = text;
    return b;
  }

  /** 지금 문제가 `solution()` 함수형인가. */
  function isFunction() {
    return Boolean(state && state.problem && state.problem.type === 'function');
  }

  /** 함수형 문제의 매개변수 이름들. */
  function signature() {
    return (state && state.problem && state.problem.signature) || [];
  }

  function renderProblem() {
    const p = state.problem;
    const sec = el(`<section>
      <h2 class="title"></h2>
      <div class="meta"></div>
      <div class="row" style="margin-bottom:8px">
        <button class="ghost" id="wide">넓게 보기</button>
        <button class="ghost" id="open-sol">solution.py</button>
        <button class="ghost" id="open-dir">폴더 열기</button>
      </div>
      <details class="problem" open>
        <summary>문제 설명</summary>
        <div class="description"></div>
      </details>
    </section>`);

    const title = sec.querySelector('.title');
    if (title) title.textContent = p.title;
    const meta = sec.querySelector('.meta');
    if (meta) meta.textContent = `#${p.lessonId} · ${state.dir || ''}`;

    const desc = sec.querySelector('.description');
    // 확장 호스트에서 이미 걸러낸 HTML이고, CSP가 스크립트를 차단한다.
    if (desc) desc.innerHTML = p.descriptionHtml;

    sec.querySelector('#wide')?.addEventListener('click', () => send('openWide'));
    sec.querySelector('#open-sol')?.addEventListener('click', () => send('openSolution'));
    sec.querySelector('#open-dir')?.addEventListener('click', () => send('openFolder'));
    return sec;
  }

  function renderCases() {
    const sec = el(`<section>
      <div class="section-head">
        <span>테스트 케이스 <span class="count"></span></span>
        <button class="ghost" id="toggle-add">+ 추가</button>
      </div>
      <div id="case-list"></div>
      <div id="add-form"></div>
    </section>`);

    const count = sec.querySelector('.count');
    if (count) count.textContent = `(${state.cases.length})`;

    const list = sec.querySelector('#case-list');
    state.cases.forEach((/** @type {any} */ c, /** @type {number} */ i) => {
      list?.appendChild(renderCase(c, i, state.results?.[i]));
    });

    sec.querySelector('#toggle-add')?.addEventListener('click', () => {
      draft.showAdd = !draft.showAdd;
      saveDraft();
      render();
    });

    if (draft.showAdd) sec.querySelector('#add-form')?.appendChild(renderAddForm());
    return sec;
  }

  /**
   * @param {any} c
   * @param {number} i
   * @param {any} result
   */
  function renderCase(c, i, result) {
    const status = result?.status;
    const meta = status ? STATUS[status] : null;
    const open = Boolean(draft.open[i] ?? (status && status !== 'pass'));

    const box = el(`<div class="case ${status || ''}">
      <div class="head">
        <span class="icon"></span>
        <span class="name"></span>
        <span class="tag"></span>
        <span class="ms"></span>
      </div>
    </div>`);

    const icon = box.querySelector('.icon');
    if (icon) icon.textContent = meta ? meta.icon : '·';
    const name = box.querySelector('.name');
    if (name) name.textContent = c.name;
    const tag = box.querySelector('.tag');
    if (tag) tag.textContent = c.source === 'official' ? '공식' : '내 케이스';
    const ms = box.querySelector('.ms');
    if (ms) ms.textContent = result ? `${result.ms}ms` : '';

    box.querySelector('.head')?.addEventListener('click', () => {
      draft.open[i] = !open;
      saveDraft();
      render();
    });

    if (!open) return box;

    const body = el('<div class="body"></div>');
    const fn = isFunction();

    if (fn) {
      const sig = signature();
      (c.args || []).forEach((a, j) => body.appendChild(io(sig[j] || `인자 ${j + 1}`, a)));
    } else {
      body.appendChild(io('입력', c.input));
    }

    // 함수형에서는 하네스가 해석한 파이썬 표현을 쓴다 — 실제값과 표기가 맞아 비교하기 쉽다.
    const expected = (result && result.expected) || c.expected;
    body.appendChild(io(fn ? '기대한 반환값' : '기대한 출력', expected, 'expected'));

    if (result && result.status !== 'pass') {
      body.appendChild(io(fn ? '실제 반환값' : '실제 출력', result.actual, 'actual'));
    }
    // 통과했더라도 내가 찍은 print 는 보여 준다 — 디버깅 중일 때 필요하다.
    if (result?.stdout?.trim()) body.appendChild(io('print 출력', result.stdout));
    if (result?.stderr?.trim()) body.appendChild(io('에러', result.stderr, 'actual'));

    if (c.source === 'user') {
      const bar = el(`<div class="row" style="margin-top:8px">
        <button class="ghost" data-act="edit">수정</button>
        <button class="ghost" data-act="del">삭제</button>
      </div>`);
      bar.querySelector('[data-act="edit"]')?.addEventListener('click', () => {
        draft.showAdd = true;
        draft.newInput = c.input || '';
        draft.newArgs = (c.args || []).slice();
        draft.newExpected = c.expected;
        draft.editIndex = i;
        saveDraft();
        render();
      });
      bar.querySelector('[data-act="del"]')?.addEventListener('click', () => send('deleteCase', { index: i }));
      body.appendChild(bar);
    }

    box.appendChild(body);
    return box;
  }

  /**
   * @param {string} label
   * @param {string} value
   * @param {string} [cls]
   */
  function io(label, value, cls) {
    const wrap = document.createElement('div');
    const l = el('<div class="io-label"></div>');
    l.textContent = label;
    const pre = el(`<pre class="io ${cls || ''} ${value ? '' : 'empty'}"></pre>`);
    pre.textContent = value || '(없음)';
    wrap.appendChild(l);
    wrap.appendChild(pre);
    return wrap;
  }

  function renderAddForm() {
    const editing = typeof draft.editIndex === 'number';
    const fn = isFunction();

    const form = el(`<div class="case" style="margin-top:8px">
      <div class="body">
        <div id="fields"></div>
        <div class="io-label" id="exp-label"></div>
        <textarea id="ce"></textarea>
        <div class="dim" id="hint" style="margin-top:5px"></div>
        <div class="row" style="margin-top:8px">
          <button id="save">${editing ? '수정 저장' : '케이스 추가'}</button>
          <button class="secondary" id="cancel-add">취소</button>
        </div>
      </div>
    </div>`);

    const fields = form.querySelector('#fields');

    /** 함수형이면 매개변수마다, 표준입출력형이면 입력 하나. */
    /** @type {HTMLTextAreaElement[]} */
    const argInputs = [];
    /** @type {HTMLTextAreaElement | null} */
    let stdinInput = null;

    /**
     * @param {string} label
     * @param {string} value
     * @param {(v: string) => void} onInput
     * @returns {HTMLTextAreaElement}
     */
    function addField(label, value, onInput) {
      const lab = el('<div class="io-label"></div>');
      lab.textContent = label;
      const ta = /** @type {HTMLTextAreaElement} */ (el('<textarea></textarea>'));
      ta.value = value;
      ta.addEventListener('input', () => { onInput(ta.value); saveDraft(); });
      fields?.appendChild(lab);
      fields?.appendChild(ta);
      return ta;
    }

    if (fn) {
      const names = signature();
      const labels = names.length ? names : ['인자 1'];
      labels.forEach((name, i) => {
        argInputs.push(addField(name, draft.newArgs[i] || '', (v) => { draft.newArgs[i] = v; }));
      });
    } else {
      stdinInput = addField('입력', draft.newInput, (v) => { draft.newInput = v; });
    }

    const expLabel = form.querySelector('#exp-label');
    if (expLabel) expLabel.textContent = fn ? '기대한 반환값' : '기대한 출력';

    const hint = form.querySelector('#hint');
    if (hint && fn) {
      hint.textContent =
        '값은 파이썬 리터럴로 씁니다 — 문자열은 "따옴표", 배열은 [1, 2, 3], 참/거짓은 True/False.';
    }

    const ce = /** @type {HTMLTextAreaElement} */ (form.querySelector('#ce'));
    ce.value = draft.newExpected;
    ce.addEventListener('input', () => { draft.newExpected = ce.value; saveDraft(); });

    form.querySelector('#save')?.addEventListener('click', () => {
      const payload = fn
        ? { args: argInputs.map((t) => t.value), expected: ce.value }
        : { input: stdinInput ? stdinInput.value : '', expected: ce.value };
      if (editing) send('updateCase', Object.assign({ index: draft.editIndex }, payload));
      else send('addCase', payload);
      resetAdd();
    });
    form.querySelector('#cancel-add')?.addEventListener('click', () => { resetAdd(); render(); });

    function resetAdd() {
      draft.showAdd = false;
      draft.newInput = '';
      draft.newArgs = [];
      draft.newExpected = '';
      draft.editIndex = null;
      saveDraft();
    }
    return form;
  }

  function renderActions() {
    const busy = Boolean(state.busy);
    const sec = el(`<section>
      <div class="btn-grid" style="margin-bottom:6px">
        <button id="run">▶ 로컬 테스트</button>
        <button id="submit" class="secondary">☁ 제출 후 채점</button>
      </div>
      <div class="btn-grid" id="explain-row"></div>
      <div id="auth-row"></div>
    </section>`);

    const run = /** @type {HTMLButtonElement} */ (sec.querySelector('#run'));
    run.disabled = busy;
    run.addEventListener('click', () => send('runLocal'));

    const submit = /** @type {HTMLButtonElement} */ (sec.querySelector('#submit'));
    submit.disabled = busy;
    submit.addEventListener('click', () => send('submit'));

    const row = sec.querySelector('#explain-row');
    for (const b of EXPLAIN_BUTTONS) {
      const btn = /** @type {HTMLButtonElement} */ (el(`<button class="ghost"></button>`));
      btn.textContent = b.label;
      btn.disabled = busy;
      btn.addEventListener('click', () => send('explain', { kind: b.kind }));
      row?.appendChild(btn);
    }

    const authRow = sec.querySelector('#auth-row');
    if (!state.auth?.ok) authRow?.appendChild(renderAuthHelp());
    return sec;
  }

  /** 쿠키를 어디서 어떻게 복사하는지 단계로 보여 준다. */
  function renderAuthHelp() {
    const b = el(`<div class="banner warn" style="margin-top:10px">
      <div id="auth-msg"></div>
      <details class="problem" style="margin-top:6px">
        <summary>쿠키 복사하는 법</summary>
        <ol style="padding-left:1.3em; margin:6px 0">
          <li>크롬에서 <b>프로그래머스에 로그인</b>한 상태로 아무 문제 페이지를 연다</li>
          <li><b>F12</b>를 눌러 개발자도구를 열고 위쪽 <b>Network</b> 탭으로 간다</li>
          <li><b>F5</b>로 페이지를 새로고침한다 (목록이 채워진다)</li>
          <li>목록 <b>맨 위</b>의 요청(이름이 <code>181950…</code> 처럼 생긴 것)을 클릭</li>
          <li>오른쪽 <b>Headers</b> 탭에서 아래로 내려 <b>Request Headers</b> 를 찾는다</li>
          <li><code>cookie:</code> 줄의 <b>값 전체</b>를 드래그해 복사한다 (<code>Ctrl+C</code>)</li>
          <li>아래 <b>쿠키 등록</b> 을 누르고 붙여넣는다 (<code>Ctrl+V</code>) → <code>Enter</code></li>
        </ol>
        <div class="dim">
          값 하나만이 아니라 <code>a=1; b=2; c=3</code> 처럼 세미콜론으로 이어진 줄 전체를
          복사해야 한다. 쿠키 이름은 몰라도 된다.
        </div>
      </details>
      <div class="row" style="margin-top:8px"><button class="ghost" id="set-cookie">쿠키 등록</button></div>
    </div>`);

    const msg = b.querySelector('#auth-msg');
    if (msg) msg.textContent = `제출하려면 로그인이 필요합니다 — ${state.auth?.reason || ''}`;
    b.querySelector('#set-cookie')?.addEventListener('click', () => send('setCookie'));
    return b;
  }

  function renderSubmitResult() {
    const r = state.submitResult;
    const sec = el(`<section>
      <div class="section-head"><span>채점 결과</span></div>
      <div class="banner ${r.passed ? 'notice' : 'error'}" id="sum"></div>
      <div id="jcases"></div>
      <div id="jnotices"></div>
    </section>`);

    const sum = sec.querySelector('#sum');
    if (sum) sum.textContent = r.summary;

    const list = sec.querySelector('#jcases');
    for (const c of r.cases) {
      const box = el(`<div class="case ${c.passed ? 'pass' : 'fail'}">
        <div class="head"><span></span><span class="name"></span><span class="ms"></span></div>
      </div>`);
      const cells = box.querySelectorAll('.head > span');
      cells[0].textContent = c.passed ? '✅' : '❌';
      cells[1].textContent = c.name;
      cells[2].textContent = c.msg;
      list?.appendChild(box);
    }

    const notices = sec.querySelector('#jnotices');
    for (const n of r.notices || []) {
      const d = el('<div class="dim" style="margin-top:6px"></div>');
      d.textContent = n;
      notices?.appendChild(d);
    }
    return sec;
  }

  function renderExplanation() {
    const e = state.explanation;
    const sec = el(`<section>
      <div class="section-head"><span></span><span class="dim"></span></div>
      <div class="explanation"></div>
    </section>`);

    const head = sec.querySelector('.section-head span');
    if (head) head.textContent = e.label;
    const dim = sec.querySelector('.dim');
    if (dim) {
      const cost = typeof e.costUsd === 'number' ? ` · $${e.costUsd.toFixed(3)}` : '';
      dim.textContent = `${(e.ms / 1000).toFixed(1)}초${cost}`;
    }
    const body = sec.querySelector('.explanation');
    if (body) body.innerHTML = renderMarkdown(e.text);
    return sec;
  }

  // ------------------------------------------------------------------ 배선

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.addEventListener('message', (ev) => {
      const msg = ev.data;
      if (msg?.type === 'state') {
        state = msg.state;
        render();
      }
    });

    render();
    send('ready');
  }

  // 웹뷰에는 module이 없다. Node에서 렌더러만 따로 테스트할 때만 걸린다.
  // @ts-ignore
  if (typeof module !== 'undefined') module.exports = { renderMarkdown, esc };
})();
