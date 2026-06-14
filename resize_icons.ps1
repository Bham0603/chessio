Add-Type -AssemblyName System.Drawing

$srcPath = "C:\Users\bham0\.gemini\antigravity-ide\brain\6ad919e6-4c7e-4862-8955-501e9529d6f6\chess_knight_icon_1781384681075.png"
$src = [System.Drawing.Image]::FromFile($srcPath)

foreach ($size in @(16, 48, 128)) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($src, 0, 0, $size, $size)
    $outPath = "icons\icon$size.png"
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    Write-Host "Created $outPath"
}

$src.Dispose()
Write-Host "Done!"
