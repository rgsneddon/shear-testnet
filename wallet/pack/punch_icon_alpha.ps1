# Punch white plates to alpha on every shipped wallet icon (Windows/macOS/iOS/Android/web).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Resolve-Path (Join-Path $PSScriptRoot '..')

$files = @(
  'windows\runner\resources\app_icon.png',
  'macos\Runner\Assets.xcassets\AppIcon.appiconset\app_icon_16.png',
  'macos\Runner\Assets.xcassets\AppIcon.appiconset\app_icon_32.png',
  'macos\Runner\Assets.xcassets\AppIcon.appiconset\app_icon_64.png',
  'macos\Runner\Assets.xcassets\AppIcon.appiconset\app_icon_128.png',
  'macos\Runner\Assets.xcassets\AppIcon.appiconset\app_icon_256.png',
  'macos\Runner\Assets.xcassets\AppIcon.appiconset\app_icon_512.png',
  'macos\Runner\Assets.xcassets\AppIcon.appiconset\app_icon_1024.png',
  'web\favicon.png',
  'web\icons\Icon-192.png',
  'web\icons\Icon-512.png',
  'web\icons\Icon-maskable-192.png',
  'web\icons\Icon-maskable-512.png',
  'android\app\src\main\res\mipmap-mdpi\ic_launcher.png',
  'android\app\src\main\res\mipmap-hdpi\ic_launcher.png',
  'android\app\src\main\res\mipmap-xhdpi\ic_launcher.png',
  'android\app\src\main\res\mipmap-xxhdpi\ic_launcher.png',
  'android\app\src\main\res\mipmap-xxxhdpi\ic_launcher.png'
)
Get-ChildItem -Path (Join-Path $root 'ios\Runner\Assets.xcassets\AppIcon.appiconset') -Filter '*.png' | ForEach-Object {
  $files += $_.FullName.Substring($root.Path.Length).TrimStart('\')
}

function Punch([string]$path) {
  $full = Join-Path $root $path
  if (-not (Test-Path $full)) { throw "missing $path" }
  $src = [System.Drawing.Bitmap]::FromFile($full)
  $w = $src.Width
  $h = $src.Height
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $cx = ($w - 1) / 2.0
  $cy = ($h - 1) / 2.0
  $limit = $w * 0.492
  $circle = $w -ge 64
  for ($y = 0; $y -lt $h; $y++) {
    for ($x = 0; $x -lt $w; $x++) {
      $c = $src.GetPixel($x, $y)
      $dx = $x - $cx
      $dy = $y - $cy
      $d = [math]::Sqrt(($dx * $dx) + ($dy * $dy))
      $white = ($c.R -ge 250 -and $c.G -ge 250 -and $c.B -ge 250)
      if ($c.A -eq 0 -or $white -or ($circle -and $d -gt $limit)) {
        $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
      } else {
        $a = if ($c.A -lt 255) { $c.A } else { 255 }
        $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($a, $c.R, $c.G, $c.B))
      }
    }
  }
  $src.Dispose()
  $tmp = $full + '.tmp.png'
  $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Move-Item -Force $tmp $full
  Write-Output "rgba $path ${w}x${h}"
}

foreach ($f in $files) { Punch $f }

# Rebuild Windows ICO from the punched 256 PNG.
& (Join-Path $PSScriptRoot 'make_windows_icons.ps1')
Write-Output 'all wallet icons punched to RGBA'
