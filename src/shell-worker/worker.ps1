<#
  DesktopOS Shell Worker -- PowerShell bridge side (Windows PowerShell 5.1)

  Why HTTP instead of stdin pipe + marker:
    - powershell.exe reads pipe stdin using [Console]::InputEncoding (CP936/gb2312
      on a zh-CN box). Any UTF-8 non-ASCII byte written by Node is decoded as GBK
      and turns into mojibake. That corrupts every Chinese path/command.
    - stdout and stderr interleave, and a terminating error makes PS exit(1),
      which swallows the end-of-command marker.
    - With HTTP both directions are explicit byte streams: command arrives as
      base64(UTF-8), response is written as UTF-8 bytes. No console encoding
      is involved anywhere.

  Why a token (added after review):
    Binding 127.0.0.1 does NOT make the endpoint private. A page can POST to
    http://127.0.0.1:<port>/exec with Content-Type: text/plain -- that is a
    CORS-safelisted value, so it is a "simple request", so the browser sends
    it WITHOUT a preflight. Reading the response is blocked, but the side
    effect already happened. Ports are random but only ~16k candidates, so a
    page can scan them in seconds. Net result would be: visiting any website
    hands it arbitrary PowerShell.
    Node therefore passes a random per-process token via argv, and every
    request must carry it in X-DOS-Token. A CUSTOM header is not
    CORS-safelisted, so cross-site requests must preflight and get blocked.
    Requests carrying an Origin header are rejected outright: the Node client
    never sends one.

  This file is intentionally pure ASCII. All non-ASCII data travels as base64,
  so PowerShell's ANSI-default script reader can never mis-decode it either.

  The runspace is persistent: Set-Location and env vars survive across requests.
#>
param(
  [int]$Port = 0,
  [string]$Token = ''
)

$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'

# 4 MB ceiling on command bodies. Nothing legitimate comes close; an unbounded
# ReadToEnd() is a trivial memory-exhaustion vector.
$MaxBodyBytes = 4 * 1024 * 1024

function ToB64([string]$s) {
  if ($null -eq $s) { $s = '' }
  return [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($s))
}

function FromB64([string]$b64) {
  if ([string]::IsNullOrEmpty($b64)) { return '' }
  return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64))
}

# Reject anything that could have been sent by a web page.
function Test-Authorized($req, [string]$Expected) {
  # Browsers always attach Origin on cross-site POST; our own client never does.
  if ($req.Headers['Origin']) { return $false }
  if ([string]::IsNullOrEmpty($Expected)) { return $true }   # manual launch, no token
  $t = $req.Headers['X-DOS-Token']
  if ([string]::IsNullOrEmpty($t)) { return $false }
  return [string]::Equals($t, $Expected, [System.StringComparison]::Ordinal)
}

function Write-Json($resp, [string]$json, [int]$code) {
  $resp.StatusCode = $code
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $resp.ContentLength64 = $bytes.Length
  $resp.OutputStream.Write($bytes, 0, $bytes.Length)
  $resp.OutputStream.Close()
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()

# Handshake: Node polls stdout for this marker. ASCII only, encoding-proof.
[Console]::Out.WriteLine("READY:$Port")
[Console]::Out.Flush()

$running = $true

while ($running) {
  $ctx = $null
  try { $ctx = $listener.GetContext() } catch { break }
  if ($null -eq $ctx) { break }

  $req  = $ctx.Request
  $resp = $ctx.Response
  $resp.ContentType = 'application/json; charset=utf-8'

  if (-not (Test-Authorized $req $Token)) {
    Write-Json $resp '{"ok":false,"error":"Zm9yYmlkZGVu"}' 403
    continue
  }

  try {
    $p    = $req.Url.AbsolutePath
    $verb = $req.HttpMethod

    if ($verb -eq 'GET' -and $p -eq '/health') {
      Write-Json $resp '{"ok":true}' 200
    }
    elseif ($verb -eq 'POST' -and $p -eq '/shutdown') {
      Write-Json $resp '{"ok":true}' 200
      $running = $false
    }
    elseif ($verb -eq 'POST' -and $p -eq '/exec') {
      if ($req.ContentLength64 -gt $MaxBodyBytes) {
        Write-Json $resp '{"ok":false,"error":"cmVxdWVzdCB0b28gbGFyZ2U="}' 413
        continue
      }

      $sr   = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
      $body = $sr.ReadToEnd()
      $sr.Close()

      $payload = $body | ConvertFrom-Json
      $cmd     = FromB64 $payload.command

      $outList = [System.Collections.Generic.List[string]]::new()
      $errList = [System.Collections.Generic.List[string]]::new()

      # $LASTEXITCODE is an automatic variable that lives in the runspace and is
      # only written by native executables. Without this reset, one failing
      # native command poisons the exit code reported for every later pure-
      # PowerShell command in the session.
      $global:LASTEXITCODE = 0

      try {
        # Execute via scriptblock + dot-sourcing (.):
        #   - dot-sourcing keeps variables / Set-Location / env in the same
        #     runspace, which is what "persistent session" means here
        #   - 2>&1 merges the error stream into the success stream, so
        #     non-terminating errors (e.g. Get-Item on a missing path) get
        #     captured. A plain Invoke-Expression does NOT surface them.
        $sb  = [scriptblock]::Create($cmd)
        $all = @(. $sb 2>&1)
        foreach ($item in $all) {
          if ($null -eq $item) { continue }
          if ($item -is [System.Management.Automation.ErrorRecord]) {
            $errList.Add($item.ToString())
          } else {
            $outList.Add([string]$item)
          }
        }
      } catch {
        # terminating errors (unknown command, etc.) land here
        $errList.Add($_.Exception.Message)
      }

      $exitCode = 0
      if ($null -ne $LASTEXITCODE) { $exitCode = [int]$LASTEXITCODE }
      if ($errList.Count -gt 0 -and $exitCode -eq 0) { $exitCode = 1 }

      $outText = [string]::Join("`n", $outList.ToArray())
      $errText = [string]::Join("`n", $errList.ToArray())
      $cwd     = (Get-Location).Path

      $json = '{"ok":true' +
              ',"output":"'   + (ToB64 $outText) +
              '","error":"'   + (ToB64 $errText) +
              '","cwd":"'     + (ToB64 $cwd) +
              '","exitCode":' + $exitCode + '}'
      Write-Json $resp $json 200
    }
    else {
      Write-Json $resp ('{"ok":false,"error":"' + (ToB64 "not found: $p") + '"}') 404
    }
  } catch {
    try { Write-Json $resp ('{"ok":false,"error":"' + (ToB64 $_.Exception.Message) + '"}') 500 } catch {}
  }
}

try { $listener.Stop() } catch {}
