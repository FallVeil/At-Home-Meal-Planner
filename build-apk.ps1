# Builds the Homebase debug APK for sideloading.
# Handles the two Windows gotchas we hit:
#   * Capacitor 8 needs JDK 21 (JDK 17 is too old, the AS jbr's Java 25 too new) -> auto-detected.
#   * Defender can intermittently lock Gradle's transform cache -> retry loop.
# Prereq (one-time, admin): Defender exclusions for C:\Users\Andrew\.gradle, this folder, and the SDK.
$ErrorActionPreference = "Stop"

# Find a JDK 21 (Android Studio downloads them under ~\.jdks).
$jdk = Get-ChildItem "$env:USERPROFILE\.jdks" -Directory -ErrorAction SilentlyContinue |
  Where-Object { Test-Path "$($_.FullName)\bin\javac.exe" } |
  Where-Object { (& "$($_.FullName)\bin\java.exe" -version 2>&1) -match '"21\.' } |
  Select-Object -First 1
if (-not $jdk) { throw "No JDK 21 found under $env:USERPROFILE\.jdks (install one via Android Studio: Settings > Build Tools > Gradle > Download JDK 21)." }
$env:JAVA_HOME = $jdk.FullName
Write-Host "Using JDK 21: $($env:JAVA_HOME)" -ForegroundColor Cyan

# Push any web/config changes into the native project, then build.
Set-Location $PSScriptRoot
npx cap sync android
Set-Location "$PSScriptRoot\android"

$ok = $false
for ($i = 1; $i -le 6; $i++) {
  Write-Host "=== build attempt $i ===" -ForegroundColor Yellow
  & .\gradlew.bat assembleDebug --no-daemon
  if ($LASTEXITCODE -eq 0) { $ok = $true; break }
  Start-Sleep -Seconds 2
}
if (-not $ok) { throw "Build failed after retries (check the Gradle output above)." }

$apk = "$PSScriptRoot\android\app\build\outputs\apk\debug\app-debug.apk"
Write-Host "`nBUILD OK -> $apk" -ForegroundColor Green
