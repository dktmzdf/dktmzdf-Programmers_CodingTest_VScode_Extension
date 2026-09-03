# CodingTestAgent

로그인을 홈페이지에서 로그인한후 쿠키를 가져다 써야하는 문제가 있음... 알아서 이 플러그인은 알아서 가져다 쓰세요

프로그래머스 스쿨 코딩테스트 숙제를 VS Code에서 풀고, 제출하고, 기록으로 남기기 위한 저장소.

| [`extension/`](extension/) | VS Code 확장 본체. **사용법은 [extension/README.md](extension/README.md)** |

## 빠른 시작

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.vscode\extensions\coding-test-agent" `
  -Target "C:\Work\PythonProject\CodingTestAgent\extension"
```

VS Code에서 `Ctrl+Shift+P` → `Developer: Reload Window` → `Ctrl+Alt+P` 로 패널을 연다.

자세한 사용법·로그인 쿠키 등록·문제 해결은 **[extension/README.md](extension/README.md)** 에 있다.
(VS Code 확장 목록에서 "코딩테스트 에이전트"를 클릭해도 같은 문서가 보인다.)

## 만들 때의 결정

Node.js 설치도 빌드 단계도 없다. 순수 JavaScript에 의존성 0개다. 가능했던 이유:

- VS Code 1.135의 확장 호스트가 **Node 24** 라서 `fetch` 와 `WebSocket` 이 전역에 있다
- 채점은 ActionCable WebSocket으로 오가는데, Node의 전역 `WebSocket` 이 `headers` 옵션을
  받아 줘서 `ws` 패키지가 필요 없었다
- 문제 페이지 파싱 앵커를 전부 실측해 둬서 HTML 파서 라이브러리 없이 정규식으로 충분했다
- HTML→Markdown은 실제 쓰이는 태그가 좁아 `src/html2md.js` 하나로 해결했다

타입 검사는 각 파일의 `// @ts-check` + JSDoc으로 한다. 빌드 없이 VS Code가 그대로 검사해 준다.

## 지원 범위

표준입출력형(`input()`/`print`)과 `solution()` 함수형 문제를 모두 지원한다. 언어는 파이썬만.
형식은 페이지의 `data-interface-type` 으로 자동 판별한다.
