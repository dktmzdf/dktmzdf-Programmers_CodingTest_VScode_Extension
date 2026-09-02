// @ts-check
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { install } = require('./_vscode-stub');

/**
 * @param {import('./assert').Suite} t
 */
module.exports = async function gitTests(t) {
  t.section('git 커밋 — 소스만 담기');

  install(); // git.js 는 codingTest.gitPath 를 읽는다 — 스텁에선 '' → 'git'
  const git = require('../src/git');

  const WORK = path.join(os.tmpdir(), 'coding-test-agent-git-' + Date.now());
  fs.mkdirSync(WORK, { recursive: true });

  // Windows 는 .git 팩 파일을 읽기전용으로 잠가 바로 지우면 EPERM 이 난다.
  // 정리 실패는 테스트 결과와 무관하므로 조용히 넘긴다.
  const rmQuiet = () => {
    try {
      fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* OS 가 나중에 임시 폴더를 정리한다 */
    }
  };

  const version = await git.run(['--version'], { cwd: WORK });
  if (version.spawnError || version.code !== 0) {
    t.skip('git 커밋 전체', 'git 을 찾지 못했다');
    rmQuiet();
    return;
  }

  try {
    // 저장소를 만든다. 이름/이메일이 없으면 커밋이 안 되므로 로컬로만 박아 준다.
    await git.init(WORK);
    await git.run(['config', 'user.email', 'test@example.com'], { cwd: WORK });
    await git.run(['config', 'user.name', 'Test'], { cwd: WORK });
    await git.run(['config', 'commit.gpgsign', 'false'], { cwd: WORK });
    // 한글 폴더명이 따옴표로 감싸져 나오면 이 테스트의 파싱이 어긋난다.
    await git.run(['config', 'core.quotepath', 'false'], { cwd: WORK });

    // 문제 폴더 하나를 흉내낸다 — 5개 파일 전부.
    const dir = path.join(WORK, 'problems', '181943-문자열-겹쳐쓰기');
    fs.mkdirSync(dir, { recursive: true });
    const files = {
      'problem.md': '# 문자열 겹쳐쓰기\n',
      'solution.py': 'def solution(a, b, s):\n    return a\n',
      'testcases.json': '{"lessonId":181943,"cases":[]}\n',
      'result.md': '# 채점 결과 이력\n(비밀 아님, 하지만 안 올려야 함)\n',
      'explanation.md': '# 해설 이력\n힌트: ...\n',
    };
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), body, 'utf8');
    }

    // 하위 폴더에서도 저장소 최상위를 제대로 찾는지.
    // git 은 슬래시(/)로, Node 는 역슬래시(\)로 경로를 주므로 정규화해 비교한다.
    const norm = (/** @type {string} */ p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
    const root = await git.repoRoot(dir);
    t.ok('하위 폴더에서 저장소 최상위를 찾는다',
      root !== null && norm(root) === norm(fs.realpathSync(WORK)),
      `root=${root}`);
    if (!root) return;

    // SOURCE_FILES 만 스테이징한다.
    const staged = git.SOURCE_FILES.map((n) => path.join(dir, n));
    await git.addPaths(root, staged);

    const listed = await git.run(['diff', '--cached', '--name-only'], { cwd: root });
    const names = listed.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      .map((p) => p.split('/').pop());

    t.eq('세 파일만 스테이징된다',
      [...names].sort(),
      ['problem.md', 'solution.py', 'testcases.json']);
    t.ok('result.md 는 스테이징되지 않는다', !names.includes('result.md'), names.join(', '));
    t.ok('explanation.md 는 스테이징되지 않는다', !names.includes('explanation.md'), names.join(', '));

    t.ok('스테이징된 변경이 있다', await git.hasStaged(root));

    await git.commit(root, '181943 문자열 겹쳐쓰기');
    const hash = await git.shortHead(root);
    t.ok('커밋되어 짧은 해시가 나온다', /^[0-9a-f]{4,}$/.test(hash), hash);

    // 다시 같은 파일을 스테이징해도 변경이 없으면 커밋할 게 없다고 봐야 한다.
    await git.addPaths(root, staged);
    t.ok('변경이 없으면 스테이징된 것도 없다', !(await git.hasStaged(root)));

    // 커밋에 정말 그 세 파일만 들어갔는지.
    const inCommit = await git.run(['show', '--name-only', '--format=', 'HEAD'], { cwd: root });
    const committed = inCommit.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      .map((p) => p.split('/').pop());
    t.eq('커밋 내용도 세 파일뿐',
      [...committed].sort(),
      ['problem.md', 'solution.py', 'testcases.json']);

    t.section('git push — 원격 확인');
    t.eq('원격이 없으면 빈 목록', await git.remotes(root), []);
    t.eq('상류가 없으면 unpushedCount 는 null', await git.unpushedCount(root, 'main'), null);
    t.eq('현재 브랜치', await git.currentBranch(root), 'main');
  } finally {
    rmQuiet();
  }
};
