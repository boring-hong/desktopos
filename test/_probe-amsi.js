/**
 * AMSI 触发点 bisect：把 perception.ps1 的新增片段拆成几个变体，
 * 逐个用 powershell -File 跑，看哪个被拦。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = path.join(__dirname, '_amsi');
fs.mkdirSync(dir, { recursive: true });

const head = [
  "$ErrorActionPreference = 'Continue'",
  'Add-Type -AssemblyName System.Drawing',
  'Add-Type -AssemblyName System.Windows.Forms',
  '',
].join('\n');

const variants = {
  '1-baseline.ps1': `${head}Write-Output 'BASE_OK'\n`,

  '2-scale-png.ps1': `${head}
function Get-EncodedBitmap($bmp, [int]$maxWidth, [string]$format) {
  $src = $bmp
  $tmp = $null
  if ($maxWidth -gt 0 -and $bmp.Width -gt $maxWidth) {
    $ratio = $maxWidth / $bmp.Width
    $nw = $maxWidth
    $nh = [int][Math]::Max(1, [Math]::Round($bmp.Height * $ratio))
    $tmp = New-Object System.Drawing.Bitmap($nw, $nh)
    $g = [System.Drawing.Graphics]::FromImage($tmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($bmp, 0, 0, $nw, $nh)
    $g.Dispose()
    $src = $tmp
  }
  $ms = New-Object System.IO.MemoryStream
  $src.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $b64 = [System.Convert]::ToBase64String($ms.ToArray())
  $ms.Dispose()
  if ($null -ne $tmp) { $tmp.Dispose() }
  return $b64
}
$b = New-Object System.Drawing.Bitmap(200, 100)
$null = Get-EncodedBitmap $b 64 'png'
Write-Output 'SCALE_PNG_OK'
`,

  '3-jpeg-codec.ps1': `${head}
function Get-EncodedBitmap($bmp, [int]$maxWidth, [string]$format) {
  $ms = New-Object System.IO.MemoryStream
  if ($format -eq 'jpeg' -or $format -eq 'jpg') {
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
    $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]82)
    $bmp.Save($ms, $codec, $params)
    $params.Dispose()
  } else {
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  }
  $b64 = [System.Convert]::ToBase64String($ms.ToArray())
  $ms.Dispose()
  return $b64
}
$b = New-Object System.Drawing.Bitmap(200, 100)
$null = Get-EncodedBitmap $b 64 'jpeg'
Write-Output 'JPEG_OK'
`,

  '4-dhash.ps1': `${head}
Add-Type -TypeDefinition @'
using System;
using System.Drawing;
public class H {
  public static ulong RegionHash(Bitmap bmp, int x, int y, int w, int h) {
    int X = Math.Max(0, x); int Y = Math.Max(0, y);
    int W = Math.Min(w, bmp.Width - X); int H = Math.Min(h, bmp.Height - Y);
    if (W <= 0 || H <= 0) return 0UL;
    using (Bitmap small = new Bitmap(9, 8)) {
      using (Graphics g = Graphics.FromImage(small)) {
        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
        g.DrawImage(bmp, new Rectangle(0, 0, 9, 8), new Rectangle(X, Y, W, H), GraphicsUnit.Pixel);
      }
      ulong hash = 0UL;
      for (int yy = 0; yy < 8; yy++) {
        for (int xx = 0; xx < 8; xx++) {
          Color c1 = small.GetPixel(xx, yy); Color c2 = small.GetPixel(xx + 1, yy);
          int l1 = (int)(0.299 * c1.R + 0.587 * c1.G + 0.114 * c1.B);
          int l2 = (int)(0.299 * c2.R + 0.587 * c2.G + 0.114 * c2.B);
          if (l2 > l1) hash |= (1UL << (yy * 8 + xx));
        }
      }
      return hash;
    }
  }
}
'@ -ReferencedAssemblies System.Drawing
$b = New-Object System.Drawing.Bitmap(200, 100)
$h = [H]::RegionHash($b, 0, 0, 200, 100)
Write-Output ('DHASH_OK ' + $h.ToString('X16'))
`,
};

// 加上当前真实的 perception.ps1 作为对照
variants['5-actual.ps1'] = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'sensor', 'perception.ps1'),
  'utf8'
);

for (const [name, body] of Object.entries(variants)) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, 'ascii');
  let out = '';
  let ok = true;
  try {
    out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', p],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  } catch (e) {
    ok = false;
    out = (e.stdout || '') + (e.stderr || '');
  }
  const blocked = /malicious|恶意/i.test(out);
  console.log(`${blocked ? 'BLOCKED ' : (ok ? 'OK      ' : 'ERR     ')} ${name}`);
  if (blocked) {
    console.log('         ' + out.split('\n').filter((l) => l.trim()).slice(0, 3).join(' | '));
  }
}
