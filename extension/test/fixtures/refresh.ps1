<#
  픽스처를 다시 받는다. 사이트가 바뀐 것 같을 때 돌린다.

      .\refresh.ps1

  로그인하지 않은 채로 받는다 — 문제 설명과 채점에 필요한 id는 비로그인으로도 전부 내려온다.
  받은 뒤 csrf 토큰만 자리표시자로 바꾼다 (README.md 참고).
#>

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# README.md 의 표와 짝을 이룬다. 문제를 더할 땐 양쪽을 같이 고친다.
$lessons = 181950, 181951, 181943, 12910, 12915, 12916, 12949, 87389, 120802

foreach ($id in $lessons) {
  $url = "https://school.programmers.co.kr/learn/courses/30/lessons/$id`?language=python3"
  try {
    $html = (Invoke-WebRequest -Uri $url -UseBasicParsing).Content
  } catch {
    Write-Warning ("{0} 받기 실패: {1}" -f $id, $_.Exception.Message)
    continue
  }

  # 익명 세션 토큰이라 쓸모없지만, 토큰처럼 생긴 문자열은 저장소에 남기지 않는다.
  $html = [regex]::Replace(
    $html,
    '(<meta name="csrf-token" content=")[^"]*(")',
    '${1}REDACTED-FOR-FIXTURE${2}'
  )

  $out = Join-Path $PSScriptRoot "$id.html"
  [System.IO.File]::WriteAllText($out, $html, [System.Text.UTF8Encoding]::new($false))
  "{0,-8} {1,6}자" -f $id, $html.Length
}

""
"받았습니다. 이제 테스트를 돌려 무엇이 달라졌는지 확인하세요:"
"    ..\run.ps1"
