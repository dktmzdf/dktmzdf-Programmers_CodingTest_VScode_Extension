<#
  테스트를 돌린다.

      .\extension\test\run.ps1

  Node.js를 설치하지 않아도 된다 — VS Code에 딸려 오는 Node를 빌려 쓴다.
  Code.exe 는 작업을 끝내기 전에 반환하므로, 결과 파일에 완료 표시가 찍힐 때까지 기다린다.
#>

$ErrorActionPreference = 'Stop'

# --- VS Code 찾기 ---------------------------------------------------------
$candidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'),
  'C:\Program Files\Microsoft VS Code\Code.exe',
  'C:\Program Files (x86)\Microsoft VS Code\Code.exe'
)
$codeCmd = Get-Command code -ErrorAction SilentlyContinue
if ($codeCmd) {
  # code.cmd 는 bin\ 아래에 있고 Code.exe 는 그 부모에 있다
  $candidates += (Join-Path (Split-Path (Split-Path $codeCmd.Source -Parent) -Parent) 'Code.exe')
}

$code = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $code) {
  Write-Error "Code.exe 를 찾지 못했습니다. VS Code 설치 경로를 확인해 주세요."
}

# --- 실행 -----------------------------------------------------------------
$result = Join-Path $PSScriptRoot 'last-run.txt'
if (Test-Path $result) { Remove-Item $result -Force }

$env:ELECTRON_RUN_AS_NODE = '1'
& $code (Join-Path $PSScriptRoot 'run.js') | Out-Null

# Code.exe 가 먼저 반환하므로 완료 표시를 기다린다.
$deadline = (Get-Date).AddSeconds(180)
$done = $false
while ((Get-Date) -lt $deadline) {
  if (Test-Path $result) {
    $text = Get-Content $result -Raw
    if ($text -match '=== DONE (PASS|FAIL) ===') { $done = $true; break }
  }
  Start-Sleep -Milliseconds 300
}

if (-not $done) {
  if (Test-Path $result) { Get-Content $result }
  Write-Error "테스트가 180초 안에 끝나지 않았습니다."
}

Get-Content $result

if ((Get-Content $result -Raw) -match '=== DONE FAIL ===') { exit 1 }
exit 0
