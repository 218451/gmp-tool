@echo off
chcp 65001 >nul 2>&1
setlocal
REM ============================================================
REM  Start the public tunnel / start public access
REM
REM  Usage:
REM    Double-click this file. A public HTTPS URL appears on screen
REM    after about 10 seconds. Send that URL to the tester.
REM    No account registration needed.
REM
REM  WARNING:
REM    1) This window MUST stay open. Close it = public access dies.
REM    2) Your PC is the server. Sleep / shutdown / offline = access dies.
REM    3) The URL changes on every restart (random subdomain).
REM    4) Only keep it running while someone is actually testing.
REM
REM  ENCODING NOTES (two bugs already hit, read before editing):
REM    1) MUST use CRLF. LF makes cmd glue the chcp line onto the
REM       next one and the whole script breaks.
REM    2) Under chcp 65001 full-width punctuation is parsed as a
REM       command separator, so the following line gets run as a
REM       command and prints "is not recognized". Every echo line
REM       below therefore uses ASCII punctuation only.
REM    3) Do NOT put the binary in a folder with Chinese characters.
REM       cmd loses the path encoding under some shells and the
REM       "if exist" check fails even though the file is there.
REM       cloudflared.exe must sit in the SAME folder as this script.
REM ============================================================

set "ROOT=%~dp0"
cd /d "%ROOT%"

echo.
echo   ============================================
echo     GMP Tool - Public Tunnel
echo   ============================================
echo.

REM --- step 1: local service must be up ---
curl -s -m 5 http://127.0.0.1:8780/api/health >nul 2>&1
if errorlevel 1 (
  echo   [ERROR] Local service is NOT running on port 8780
  echo.
  echo   Start it first: double-click the other launcher
  echo   in this folder, then run this file again.
  echo.
  pause
  exit /b 1
)
echo   Local service: OK
echo.

REM --- step 2: binary must sit next to this script ---
if not exist "%ROOT%cloudflared.exe" (
  echo   [ERROR] cloudflared.exe not found next to this script
  echo.
  pause
  exit /b 1
)

REM --- step 3: open the tunnel, with one automatic retry ---
REM WHY the CA pool is needed on this machine:
REM   The Windows root store here holds only 46 certificates and none
REM   from Google Trust Services, so Go's default trust pool rejects
REM   Cloudflare's own certificate with
REM   "x509: certificate signed by unknown authority". That failure is
REM   intermittent (some Cloudflare edges chain to a root we DO have),
REM   which is why it worked 3 times out of 4 and then stopped.
REM   Passing an explicit CA bundle removes the randomness.
REM   Do NOT delete ca-bundle.crt. It is copied from the Git install.
set ATTEMPT=1
set CAPOOL=
if exist "%ROOT%ca-bundle.crt" set CAPOOL=--origin-ca-pool "%ROOT%ca-bundle.crt"

:LAUNCH
if %ATTEMPT% equ 1 goto RUN
taskkill /f /im cloudflared.exe >nul 2>&1
timeout /t 3 /nobreak >nul 2>&1

:RUN
del /q "%ROOT%tunnel.log" >nul 2>&1
cmd /c start "" /b cmd /c ""%ROOT%cloudflared.exe" tunnel --no-autoupdate %CAPOOL% --url "http://127.0.0.1:8780" > "%ROOT%tunnel.log" 2>&1"

REM --- step 4: wait for the URL and show it big ---
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%等待隧道地址.ps1"
if errorlevel 1 goto RETRY

echo   ------------------------------------------------------------
echo    Detailed log: tunnel.log in this folder
echo    Keep this window open the whole time they are testing.
echo   ------------------------------------------------------------
echo.

REM --- step 5: wait until the tunnel process ends, then clean up ---
:WAIT
timeout /t 3 /nobreak >nul 2>&1
tasklist 2>&1 | findstr /i "cloudflared.exe" >nul 2>&1
if not errorlevel 1 goto WAIT

echo.
echo   Tunnel closed. Public access is now disabled.
pause
exit /b 0

:RETRY
REM NOTE: this uses goto instead of a parenthesised if block on purpose.
REM Inside (...) the %ATTEMPT% variable is expanded when the block is
REM parsed, so "set /a ATTEMPT+=1" would have no effect on the very
REM next "if" line, and the retry would loop forever.
if %ATTEMPT% geq 3 goto GIVEUP

set /a ATTEMPT+=1
echo.
echo   Attempt %ATTEMPT% of 3 ...
echo.
timeout /t 5 /nobreak >nul 2>&1
goto RUN

:GIVEUP
echo.
echo   Could not get the public URL after 3 attempts.
echo   See tunnel.log in this folder for details.
echo.
pause
exit /b 1