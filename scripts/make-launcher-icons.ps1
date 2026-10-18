# 从 public/icon-cardflow-512.png 生成安卓启动图标（mipmap 各密度 + 自适应图标）。
# 之所以要它：AndroidManifest 里没有 android:icon，res/ 下也没有 mipmap —— 装出来就是系统默认的绿色机器人。
# 用法：powershell -ExecutionPolicy Bypass -File scripts/make-launcher-icons.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'public\icon-cardflow-512.png'
$res = Join-Path $root 'android\app\src\main\res'
if (-not (Test-Path $source)) { throw "找不到图标源文件：$source" }

# 图标底色（自适应图标的背景层；前景是全出血的图标，遮盖不到的地方就靠它补）
$background = '#1F69B1'

# 传统图标：外壳自己会裁圆角，直接用整张图
$legacy = @{ 'mdpi' = 48; 'hdpi' = 72; 'xhdpi' = 96; 'xxhdpi' = 144; 'xxxhdpi' = 192 }
# 自适应图标前景：108dp 画布（mdpi 基准），外面 18dp 会被遮罩裁掉，正好是渐变底色，看不出来
$foreground = @{ 'mdpi' = 108; 'hdpi' = 162; 'xhdpi' = 216; 'xxhdpi' = 324; 'xxxhdpi' = 432 }

$img = [System.Drawing.Image]::FromFile($source)
try {
  function Save-Resized([System.Drawing.Image]$src, [int]$size, [string]$path) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
    } finally { $g.Dispose() }
    $dir = Split-Path -Parent $path
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  }

  foreach ($dpi in $legacy.Keys) {
    Save-Resized $img $legacy[$dpi] (Join-Path $res "mipmap-$dpi\ic_launcher.png")
    Save-Resized $img $foreground[$dpi] (Join-Path $res "mipmap-$dpi\ic_launcher_foreground.png")
  }

  # 自适应图标（Android 8+）：背景纯色 + 前景整张图
  $anydpi = Join-Path $res 'mipmap-anydpi-v26'
  if (-not (Test-Path $anydpi)) { New-Item -ItemType Directory -Force -Path $anydpi | Out-Null }
  @"
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
"@ | Set-Content -Path (Join-Path $anydpi 'ic_launcher.xml') -Encoding UTF8

  $values = Join-Path $res 'values'
  if (-not (Test-Path $values)) { New-Item -ItemType Directory -Force -Path $values | Out-Null }
  @"
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">$background</color>
</resources>
"@ | Set-Content -Path (Join-Path $values 'ic_launcher_background.xml') -Encoding UTF8

  Write-Output "已生成启动图标：$res\mipmap-*（传统 48–192px + 自适应前景 108–432px）"
} finally {
  $img.Dispose()
}
