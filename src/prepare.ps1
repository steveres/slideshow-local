<#
  Prepares a photo folder for slideshow.html:
    1. Converts .heic/.heif files to .jpg (keeps date and GPS metadata). Installs ImageMagick if needed.
    2. Writes slideshow.json listing every image and video in date-taken order.
  Usage:  prepare.bat "C:\path\to\photos"     (or drag the folder onto prepare.bat)
  Safe to re-run: already-converted files are skipped and slideshow.json is rewritten.
  Written for Windows PowerShell 5.1 (built into Windows 10/11).
#>
param([Parameter(Mandatory = $true)][string]$Folder)
$ErrorActionPreference = 'Stop'

# Keep these lists in step with IMAGE_EXT / VIDEO_EXT in src/slideshow.ts
$ImageExt   = '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.svg'
$VideoExt   = '.mp4', '.m4v', '.webm', '.mov', '.ogv'
$HeicExt    = '.heic', '.heif'
$ConfigName = 'slideshow.json'
$JpegQuality = 92

$Folder = $Folder.Trim('"')
if (-not (Test-Path -LiteralPath $Folder -PathType Container)) {
  Write-Host "Folder not found: $Folder" -ForegroundColor Red
  exit 1
}
$Folder = (Resolve-Path -LiteralPath $Folder).Path

# ---------- ImageMagick (only needed when there are HEIC files) ----------

function Find-Magick {
  $cmd = Get-Command magick -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $hit = Get-ChildItem -Path "$env:ProgramFiles\ImageMagick*\magick.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit) { return $hit.FullName }
  return $null
}

function Install-Magick {
  $magick = Find-Magick
  if ($magick) { return $magick }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'ImageMagick is not installed and winget is not available. Install it from https://imagemagick.org/script/download.php and run this again.'
  }
  Write-Host 'ImageMagick is required to convert HEIC files. Installing it with winget...'
  & winget install --id ImageMagick.ImageMagick -e --accept-source-agreements --accept-package-agreements
  # Pick up the PATH change made by the installer without reopening the window
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  $magick = Find-Magick
  if (-not $magick) { throw 'ImageMagick was installed but magick.exe was not found. Close this window and run the script again.' }
  return $magick
}

# ---------- Date readers ----------

$script:HasDrawing = $false
try { Add-Type -AssemblyName System.Drawing; $script:HasDrawing = $true } catch { }

# EXIF DateTimeOriginal (36867), falling back to DateTime (306). Reads metadata only, not pixels.
function Get-ExifDate([string]$Path) {
  if (-not $script:HasDrawing) { return $null }
  $fs = $null; $img = $null
  try {
    $fs = [IO.File]::OpenRead($Path)
    $img = [Drawing.Image]::FromStream($fs, $false, $false)
    foreach ($tag in 36867, 306) {
      if ($img.PropertyIdList -contains $tag) {
        $text = [Text.Encoding]::ASCII.GetString($img.GetPropertyItem($tag).Value)
        if ($text -match '^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})' -and $Matches[1] -ne '0000') {
          return "$($Matches[1])-$($Matches[2])-$($Matches[3]) $($Matches[4])"
        }
      }
    }
  } catch { } finally {
    if ($img) { $img.Dispose() }
    if ($fs) { $fs.Dispose() }
  }
  return $null
}

# Best effort: creation time from the MP4/MOV "mvhd" header (seconds since 1904, UTC).
function Get-VideoDate([IO.FileInfo]$File) {
  $chunk = 1048576
  $fs = $null
  try {
    $fs = [IO.File]::OpenRead($File.FullName)
    $offsets = @([long]0)
    if ($File.Length -gt $chunk) { $offsets += [Math]::Max([long]$chunk, $File.Length - $chunk) }
    $latin1 = [Text.Encoding]::GetEncoding(28591)
    $buf = New-Object byte[] $chunk
    foreach ($offset in $offsets) {
      [void]$fs.Seek($offset, [IO.SeekOrigin]::Begin)
      $read = $fs.Read($buf, 0, $chunk)
      $i = $latin1.GetString($buf, 0, $read).IndexOf('mvhd', [StringComparison]::Ordinal)
      if ($i -lt 0 -or $i + 20 -gt $read) { continue }
      $p = $i + 8                             # skip "mvhd" + version/flags
      if ($buf[$i + 4] -eq 1) { $p += 4 }     # version 1 stores 64-bit times; take the low 32 bits
      $secs = [double]$buf[$p] * 16777216 + [double]$buf[$p + 1] * 65536 + [double]$buf[$p + 2] * 256 + [double]$buf[$p + 3]
      if ($secs -le 0) { continue }
      $epoch = New-Object DateTime 1904, 1, 1, 0, 0, 0, ([DateTimeKind]::Utc)
      return $epoch.AddSeconds($secs).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss')
    }
  } catch { } finally {
    if ($fs) { $fs.Dispose() }
  }
  return $null
}

# ---------- 1. Convert HEIC -> JPEG ----------

$heic = @(Get-ChildItem -LiteralPath $Folder -File | Where-Object { $HeicExt -contains $_.Extension.ToLower() })
$converted = 0; $skipped = 0; $failed = 0
if ($heic.Count -gt 0) {
  $magick = Install-Magick
  $n = 0
  foreach ($f in $heic) {
    $n++
    $target = Join-Path $Folder ($f.BaseName + '.jpg')
    if (Test-Path -LiteralPath $target) { $skipped++; continue }
    Write-Progress -Activity 'Converting HEIC to JPEG' -Status "$n of $($heic.Count): $($f.Name)" -PercentComplete (100 * $n / $heic.Count)
    & $magick $f.FullName -quality $JpegQuality $target
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $target)) {
      $failed++
      Write-Warning "Could not convert $($f.Name)"
    } else { $converted++ }
  }
  Write-Progress -Activity 'Converting HEIC to JPEG' -Completed
}

# ---------- 2. Read dates and write the ordered list ----------

$media = @(Get-ChildItem -LiteralPath $Folder -File | Where-Object { ($ImageExt + $VideoExt) -contains $_.Extension.ToLower() })
$n = 0
$entries = foreach ($f in $media) {
  $n++
  Write-Progress -Activity 'Reading dates' -Status "$n of $($media.Count)" -PercentComplete (100 * $n / $media.Count)
  $taken = $null; $source = $null
  if ($VideoExt -contains $f.Extension.ToLower()) {
    $taken = Get-VideoDate $f
    if ($taken) { $source = 'video' }
  } else {
    $taken = Get-ExifDate $f.FullName
    if ($taken) { $source = 'exif' }
  }
  if (-not $taken) {
    $taken = $f.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')
    $source = 'modified'
  }
  [pscustomobject]@{ name = $f.Name; taken = $taken; source = $source }
}
Write-Progress -Activity 'Reading dates' -Completed

$sorted = @($entries | Sort-Object taken, name)
$config = [ordered]@{
  generated = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  files     = $sorted
}
$json = $config | ConvertTo-Json -Depth 4
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[IO.File]::WriteAllText((Join-Path $Folder $ConfigName), $json, $utf8NoBom)

# ---------- Summary ----------

$byFallback = @($sorted | Where-Object { $_.source -eq 'modified' }).Count
Write-Host ''
Write-Host "Folder:    $Folder"
if ($heic.Count -gt 0) { Write-Host "HEIC:      $converted converted, $skipped already done, $failed failed" }
Write-Host "Listed:    $($sorted.Count) files in $ConfigName, in date order"
if ($byFallback -gt 0) { Write-Host "Note:      $byFallback had no capture date and were placed by file-modified time" -ForegroundColor Yellow }
if ($failed -gt 0) { exit 1 }
