@echo off
REM Build the Windows client EXE for Homescapes Save Studio.
REM
REM Mirrors the IGG VIP Studio client build (PyInstaller onedir). Output:
REM   client\dist\Homescapes Save Studio\   (foldered EXE)
REM   client\dist\HOMESC.SAVE.STUDIO.zip    (the asset CLIENT_UPDATE_URL points at)
REM
REM Prereqs (one-time):
REM   pip install pyinstaller pywebview
REM   (optional) drop adb.exe + AdbWinApi.dll + AdbWinUsbApi.dll into client\adb\
REM
REM After building, publish the zip as a GitHub Release asset, then paste its
REM URL + SHA-256 into the Render env vars CLIENT_UPDATE_URL / CLIENT_UPDATE_SHA256
REM (or issue them through the Owner Hub -> Publish update).
setlocal
cd /d "%~dp0"
python -m PyInstaller --clean --noconfirm homescapes_client.spec
if errorlevel 1 (
  echo [build] PyInstaller failed
  exit /b 1
)
powershell -NoProfile -Command "Compress-Archive -Path 'dist\Homescapes Save Studio' -DestinationPath 'dist\HOMESC.SAVE.STUDIO.zip' -Force"
if errorlevel 1 (
  echo [build] zip failed
  exit /b 1
)
echo [build] done -> dist\HOMESC.SAVE.STUDIO.zip
echo [build] sha256:
powershell -NoProfile -Command "Get-FileHash 'dist\HOMESC.SAVE.STUDIO.zip' -Algorithm SHA256 | Select-Object -ExpandProperty Hash"
endlocal