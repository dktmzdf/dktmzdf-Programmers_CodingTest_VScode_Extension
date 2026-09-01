// @ts-check
'use strict';

const { htmlToMarkdown, decodeEntities, extractBalancedDiv } = require('../src/html2md');

// 웹뷰 스크립트지만 Node에서 불러오면 렌더러만 내보내도록 되어 있다.
const { renderMarkdown } = require('../media/panel.js');

/**
 * @param {import('./assert').Suite} t
 */
module.exports = function markdownTests(t) {
  t.section('HTML → Markdown (문제 본문)');

  t.eq(
    '엔티티 디코드',
    decodeEntities('a &amp; b &#39;c&#39; &le; d'),
    "a & b 'c' ≤ d"
  );

  t.eq(
    '코드 블록은 안쪽이 변형되지 않는다',
    htmlToMarkdown('<p>보기</p><pre class="codehilite"><code>a &lt; b\n</code></pre>'),
    '보기\n\n```\na < b\n```'
  );

  t.eq(
    '인라인 코드와 목록',
    htmlToMarkdown('<h5>제한사항</h5><ul><li>1 ≤ <code>n</code> ≤ 5</li></ul>'),
    '##### 제한사항\n\n- 1 ≤ `n` ≤ 5'
  );

  t.ok(
    '표를 Markdown 표로',
    htmlToMarkdown('<table class="table"><thead><tr><th>n</th><th>result</th></tr></thead>' +
      '<tbody><tr><td>10</td><td>3</td></tr></tbody></table>').includes('| n | result |')
  );

  t.section('div 균형 잡기');
  {
    const html = '<div class="markdown"><p>x</p><div class="inner">y</div></div><div>다음</div>';
    t.eq(
      '중첩 div를 세어 짝을 찾는다',
      extractBalancedDiv(html, 0),
      '<p>x</p><div class="inner">y</div>'
    );
  }

  t.section('웹뷰 마크다운 렌더러 (해설 표시용)');

  t.ok(
    '코드 펜스',
    renderMarkdown('보기\n\n```python\nprint(1)\n```').includes('<pre><code>print(1)</code></pre>')
  );

  t.ok('인라인 코드', renderMarkdown('`n` 은 정수').includes('<code>n</code>'));
  t.ok('굵게', renderMarkdown('**꼭** 확인').includes('<strong>꼭</strong>'));
  t.ok('순서 목록', renderMarkdown('1. 하나\n2. 둘').includes('<ol><li>하나</li><li>둘</li></ol>'));

  // 자리표시자가 헐거우면 "B1" 같은 평범한 텍스트가 코드 블록으로 둔갑한다.
  {
    const out = renderMarkdown('행렬 B1 과 B2 를 곱한다.\n\n```\nX\n```\n\nB3 도 마찬가지.');
    t.ok('B1 같은 텍스트가 코드 블록을 삼키지 않는다',
      out.includes('B1') && out.includes('B2') && out.includes('B3') && out.includes('<pre><code>X</code></pre>'),
      out);
  }

  // 해설은 외부에서 온 텍스트다. 그대로 innerHTML 에 들어가므로 반드시 이스케이프돼야 한다.
  {
    const out = renderMarkdown('<img src=x onerror="alert(1)"> 그리고 <script>alert(2)</script>');
    t.ok('HTML 주입 차단',
      !out.includes('<img') && !out.includes('<script') && out.includes('&lt;img'),
      out);
  }
};
