/**
 * AMSI 第二轮：从真实 perception.ps1 出发，逐个剥离可疑片段，找出组合触发点。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = path.join(__dirname, '_amsi');
fs.mkdirSync(dir, { recursive: true });

const real = fs.readFileSync(path.join(__dirname, '..', 'src', 'sensor', 'perception.ps1'), 'utf8');

// 当前的 JPEG 分支（codec 枚举 + EncoderParameters）
const jpegBlock = `  if ($format -eq 'jpeg' -or $format -eq 'jpg') {
    # 82 is the usual quality/size knee for UI screenshots.
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
             Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
    $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
      [System.Drawing.Imaging.Encoder]::Quality, [long]82)
    $src.Save($ms, $codec, $params)
    $params.Dispose()
  } else {
    $src.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  }`;

const simpleJpeg = `  if ($format -eq 'jpeg' -or $format -eq 'jpg') {
    $src.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  } else {
    $src.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  }`;

const pngOnly = `  $src.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $src.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)`;
// 上面那行是占位，真正的单 PNG 版本在下面用 replace 生成
const pngOnlyReal = `  $src.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)`;

if (!real.includes(jpegBlock)) {
  console.log('!! 没找到预期的 JPEG 代码块，先确认文件内容');
  process.exit(1);
}

const variants = {
  'A-as-is.ps1': real,
  'B-simple-jpeg.ps1': real.replace(jpegBlock, simpleJpeg),
  'C-png-only.ps1': real.replace(jpegBlock, pngOnlyReal),
};

for (const [name, body] of Object.entries(variants)) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, 'ascii');
  let out = '';
  let ok = true;
  try {
    out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', p],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
  } catch (e) {
    ok = false;
    out = (e.stdout || '') + (e.stderr || '');
  }
  const blocked = /malicious|恶意/i.test(out);
  // 正常情况：一直等 HTTP 请求 -> 超时被杀；被 AMSI 拦：立刻退出
  const status = blocked ? 'BLOCKED' : (ok ? 'OK' : (/timed out|ETIMEDOUT|killed/i.test(out + '') ? 'RAN(超时=正常)' : 'ERR'));
  console.log(`${status.padEnd(14)} ${name}`);
}

// 逐字节确认换行/编码没变
const b = fs.readFileSync(path.join(dir, 'A-as-is.ps1'));
console.log('\nA 变体字节数 =', b.length, '| 含非 ASCII =', /[^\x00-\x7F]/.test(b.toString('latin1')));
