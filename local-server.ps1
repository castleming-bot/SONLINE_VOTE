# ============================================================================
#  local-server.ps1 - 내 컴퓨터에서 사이트를 미리 열어 보는 간단한 서버
# ============================================================================
#  사용법: 이 파일을 마우스 오른쪽 클릭 → "PowerShell에서 실행"
#          (또는 PowerShell 에서  .\local-server.ps1 )
#          그다음 브라우저에서 http://localhost:5500 을 엽니다. 끄려면 창을 닫으세요.
#  별도 프로그램 설치 없이 Windows 기본 기능만 사용합니다.
# ============================================================================
param([int]$Port = 5500)

$root = $PSScriptRoot
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'; '.csv' = 'text/csv; charset=utf-8'
  '.png'  = 'image/png'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'
  '.webp' = 'image/webp'; '.gif' = 'image/gif'; '.svg' = 'image/svg+xml'; '.ico' = 'image/x-icon'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "http://localhost:$Port 에서 실행 중입니다. (끄려면 이 창을 닫으세요)"

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    # 주소를 파일 경로로 바꿉니다. 폴더를 가리키면 index.html 을 보여 줍니다.
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ($rel -eq '') { $rel = 'index.html' }
    $path = [IO.Path]::GetFullPath((Join-Path $root $rel))

    # 사이트 폴더 밖의 파일은 보여 주지 않습니다.
    if ($path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path $path -PathType Leaf)) {
      $bytes = [IO.File]::ReadAllBytes($path)
      $type = $types[[IO.Path]::GetExtension($path).ToLower()]
      if (-not $type) { $type = 'application/octet-stream' }
      $ctx.Response.ContentType = $type
      $ctx.Response.Headers.Add('Cache-Control', 'no-store')
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
    }
  } catch {
    $ctx.Response.StatusCode = 500
  } finally {
    $ctx.Response.Close()
  }
}
