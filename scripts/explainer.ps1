# Makes the plain-words explainer video: the problem, the idea and how it works, with a voice,
# captions and quiet music.
#
#   powershell -ExecutionPolicy Bypass -File scripts\explainer.ps1 [-Work <folder>] [-Engine kokoro|windows] [-Voice af_bella] [-Rate 0.85] [-EncodeOnly]
#
# It needs Node, Edge or Chrome, and ffmpeg. The result is docs\demo\nobody-explained.mp4.
# The default voice is Kokoro, which needs `npm install` in film\ once. It downloads its models on
# first use, unless MODEL_CACHE names a folder that already has them. -Engine windows uses a voice
# built into Windows instead (Heera at 1.07), with no packages and no downloads.
# -EncodeOnly reuses the frames and sound already in -Work, and only makes the MP4 again.
param(
  [string]$Work = (Join-Path $env:TEMP 'nobody-explainer'),
  [ValidateSet('kokoro', 'windows')][string]$Engine = 'kokoro',
  [string]$Voice = '',
  [double]$Rate = 0,
  [string]$Ffmpeg = (Join-Path $env:USERPROFILE 'dev-tools\ffmpeg\ffmpeg.exe'),
  [switch]$EncodeOnly
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $EncodeOnly) {
  & node film/explainer.mjs script $Work
  if ($LASTEXITCODE) { exit 1 }
  if ($Engine -eq 'kokoro') {
    if (-not $Voice) { $Voice = 'af_bella' }
    # Kokoro at 1.0 speaks about 190 words a minute. 0.85 is about 165, easier to follow.
    if (-not $Rate) { $Rate = 0.85 }
    if (-not (Test-Path (Join-Path $root 'film\node_modules\kokoro-js'))) { throw 'Run npm install in film\ first, or use -Engine windows.' }
    & node film/kokoro.mjs $Work $Voice $Rate
  } else {
    if (-not $Voice) { $Voice = 'Heera' }
    if (-not $Rate) { $Rate = 1.07 }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'film\voice.ps1') -In (Join-Path $Work 'narration.json') -OutDir (Join-Path $Work 'voice') -Voice $Voice -Rate $Rate
  }
  if ($LASTEXITCODE) { exit 1 }
  & node film/explainer.mjs record $Work
  if ($LASTEXITCODE) { exit 1 }
}

New-Item -ItemType Directory -Force -Path 'docs\demo' | Out-Null
$out = Join-Path $root 'docs\demo\nobody-explained.mp4'
Push-Location $Work
# The browser's JPEG frames are full-range BT.601, and players expect limited-range BT.709 for HD.
# The voice is levelled to -16 LUFS. The music track is already far below it, so it is mixed as is.
$graph = '[0:v]scale=in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p[pic];' +
  '[1:a]loudnorm=I=-16:TP=-2:LRA=7,aresample=44100,aformat=channel_layouts=stereo[v];' +
  '[v][2:a]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=0[a]'
$encode = @('-y', '-loglevel', 'error', '-framerate', '30', '-i', 'frames/%06d.jpg', '-i', 'voice.wav', '-i', 'bed.wav',
  '-filter_complex', $graph, '-map', '[pic]', '-map', '[a]',
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-tune', 'animation',
  '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-shortest', '-movflags', '+faststart', $out)
& $Ffmpeg @encode
$code = $LASTEXITCODE
Pop-Location
if ($code) { exit 1 }
"Done: $out, $([math]::Round((Get-Item $out).Length / 1MB, 1)) MB"
