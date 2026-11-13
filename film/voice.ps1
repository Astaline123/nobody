# Speaks each line of the explainer with a voice built into Windows, offline. It writes one WAV per
# line, and NN.json with the time each word starts, so pictures can land on the word they illustrate.
#
#   powershell -File film\voice.ps1 -In narration.json -OutDir voice [-Voice Heera] [-Rate 1.0]
param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string]$Voice = 'Heera',
  [double]$Rate = 1.0
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
[void][Windows.Media.Core.SpeechCue, Windows.Media.Core, ContentType = WindowsRuntime]

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
  Select-Object -First 1

function Wait-Operation($operation, [type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
  [void]$task.Wait(-1)
  return $task.Result
}

$speaker = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$chosen = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -match $Voice } | Select-Object -First 1
if (-not $chosen) { throw "No voice matches $Voice" }
$speaker.Voice = $chosen
$speaker.Options.SpeakingRate = $Rate
$timed = $true
try { $speaker.Options.IncludeWordBoundaryMetadata = $true } catch { $timed = $false }
"Voice: $($chosen.DisplayName) ($($chosen.Language)), rate $Rate, word times: $timed"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$lines = Get-Content $In -Raw -Encoding UTF8 | ConvertFrom-Json
$index = 0
$found = 0
foreach ($line in $lines) {
  $stream = Wait-Operation ($speaker.SynthesizeTextToStreamAsync($line)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
  $words = New-Object System.Collections.ArrayList
  if ($timed) {
    foreach ($track in $stream.TimedMetadataTracks) {
      foreach ($cue in $track.Cues) {
        [void]$words.Add([ordered]@{ text = [string]$cue.Text; ms = [math]::Round($cue.StartTime.TotalMilliseconds) })
      }
    }
  }
  $found += $words.Count
  $size = [uint32]$stream.Size
  $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
  [void](Wait-Operation ($reader.LoadAsync($size)) ([uint32]))
  $bytes = New-Object byte[] $size
  $reader.ReadBytes($bytes)
  $name = '{0:d2}' -f $index
  [System.IO.File]::WriteAllBytes((Join-Path $OutDir "$name.wav"), $bytes)
  $json = ConvertTo-Json -InputObject @($words) -Compress
  [System.IO.File]::WriteAllText((Join-Path $OutDir "$name.json"), $json, (New-Object System.Text.UTF8Encoding($false)))
  $index += 1
}
"$index lines spoken, $found word times"
