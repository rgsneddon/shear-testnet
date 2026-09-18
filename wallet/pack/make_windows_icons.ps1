# Punch the white plate out of the pack mark. One RGBA icon reads on light and dark taskbars.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$res = Join-Path $PSScriptRoot '..\windows\runner\resources'
$srcPath = Join-Path $res 'app_icon.png'
$src = [System.Drawing.Bitmap]::FromFile((Resolve-Path $srcPath))

function New-ArgbClone([System.Drawing.Bitmap]$src) {
  $w = $src.Width
  $h = $src.Height
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $cx = ($w - 1) / 2.0
  $cy = ($h - 1) / 2.0
  $limit = $w * 0.492
  for ($y = 0; $y -lt $h; $y++) {
    for ($x = 0; $x -lt $w; $x++) {
      $c = $src.GetPixel($x, $y)
      $dx = $x - $cx
      $dy = $y - $cy
      $d = [math]::Sqrt(($dx * $dx) + ($dy * $dy))
      $white = ($c.R -ge 250 -and $c.G -ge 250 -and $c.B -ge 250)
      if ($c.A -eq 0 -or $white -or $d -gt $limit) {
        $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
      } else {
        $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, $c.R, $c.G, $c.B))
      }
    }
  }
  return $bmp
}

function Scale-Bitmap([System.Drawing.Bitmap]$src, [int]$size) {
  $dst = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($dst)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($src, 0, 0, $size, $size)
  $g.Dispose()
  return $dst
}

function Write-Ico([System.Drawing.Bitmap]$src, [string]$path) {
  $sizes = @(16, 24, 32, 48, 256)
  $pngs = @()
  foreach ($s in $sizes) {
    $b = Scale-Bitmap $src $s
    $ms = New-Object System.IO.MemoryStream
    $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngs += ,@{ w = $s; h = $s; data = $ms.ToArray() }
    $ms.Dispose()
    $b.Dispose()
  }
  $n = $pngs.Count
  $offset = 6 + (16 * $n)
  $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Create)
  $bw = New-Object System.IO.BinaryWriter $fs
  $bw.Write([uint16]0)
  $bw.Write([uint16]1)
  $bw.Write([uint16]$n)
  foreach ($p in $pngs) {
    $ww = if ($p.w -ge 256) { 0 } else { $p.w }
    $hh = if ($p.h -ge 256) { 0 } else { $p.h }
    $bw.Write([byte]$ww)
    $bw.Write([byte]$hh)
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]32)
    $bw.Write([uint32]$p.data.Length)
    $bw.Write([uint32]$offset)
    $offset += $p.data.Length
  }
  foreach ($p in $pngs) { $bw.Write($p.data) }
  $bw.Flush()
  $fs.Close()
}

$clear = New-ArgbClone $src
$src.Dispose()
$tmp = Join-Path $res 'app_icon.png.tmp.png'
$clear.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
Move-Item -Force $tmp (Join-Path $res 'app_icon.png')
Write-Ico $clear (Join-Path $res 'app_icon.ico')
$clear.Dispose()
Write-Output 'wrote RGBA app_icon.png + app_icon.ico'
