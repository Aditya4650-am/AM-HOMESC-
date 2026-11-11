@echo off
REM Build the Windows client EXE for Homescapes Save Studio.
REM
REM PyInstaller onefile: the deliverable is ONE file clients double-click.
REM Output:
REM   client\dist\Homescapes Save Studio.exe   (the single-file client)
REM   client\dist\HOMESC.SAVE.STUDIO.exe       (release asset name + checksum)
REM   client\dist\HOMESC.SAVE.STUDIO.exe.sha256
REM
REM Prereqs (one-time):
REM   pip install pyinstaller pywebview
REM   (optional) drop adb.exe + AdbWinApi.dll + AdbWinUsbApi.dll into client\adb\
REM   (adb is packed INSIDE the exe - clients need nothing else)
REM
REM Publish: tag a release (git tag v1.1.1 && git push origin v1.1.1) and the
REM build-client workflow attaches the EXE + its .sha256 automatically. The
REM server reads that GitHub release directly, so installed EXEs update
REM themselves - nothing is pasted into Render.
setlocal
cd /d "%~dp0"
python -m PyInstaller --clean --noconfirm homescapes_client.spec
if errorlevel 1 (
  echo [build] PyInstaller failed
  exit /b 1
)
if not exist "dist\Homescapes Save Studio.exe" (
  echo [build] expected dist\Homescapes Save Studio.exe
  exit /b 1
)
powershell -NoProfile -Command "Copy-Item 'dist\Homescapes Save Studio.exe' 'dist\HOMESC.SAVE.STUDIO.exe' -Force; $h=(Get-FileHash 'dist\HOMESC.SAVE.STUDIO.exe' -Algorithm SHA256).Hash; $s=(Get-Item 'dist\HOMESC.SAVE.STUDIO.exe').Length; Write-Output ('sha256=' + $h); Write-Output ('bytes=' + $s)"
if errorlevel 1 (
  echo [build] checksum failed
  exit /b 1
)
echo [build] done: dist\Homescapes Save Studio.exe  (send THIS file to clients)
endlocal
