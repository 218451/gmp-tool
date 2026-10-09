@echo off
chcp 65001 >nul 2>&1
setlocal
REM ============================================================
REM  Reset admin password / 重置 admin 密码
REM
REM  How to use:
REM    1. Right-click this file -> Run as administrator
REM    2. Press Enter when asked (auto-generates a random password)
REM    3. Copy the password shown on screen
REM
REM  Restart the app after this for the new password to take effect.
REM
REM  IMPORTANT: two bugs already hit while writing this file.
REM  1) MUST use CRLF line endings. LF makes cmd glue the chcp
REM     line onto the next one and everything breaks.
REM  2) Under chcp 65001, full-width punctuation is parsed as a
REM     command separator, so the following line runs as a
REM     command and prints "is not recognized". All echo text
REM     below therefore uses ASCII punctuation only.
REM ============================================================

set "ROOT=%~dp0"
cd /d "%ROOT%server"

echo.
echo   ============================================
echo     重置 admin 密码
echo   ============================================
echo.

netstat -ano | findstr ":8780" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo   [注意] 检测到服务正在运行
  echo          改完密码后需要重启服务才生效
  echo.
)

echo   请输入新的 admin 密码
echo   直接按回车 = 自动生成随机强密码
echo.
set /p NEWPASS=   新密码:
echo.

if "%NEWPASS%"=="" goto GENERATE

node tools/reset-admin-password.cjs "%NEWPASS%"
if errorlevel 1 (
  echo.
  echo   [失败] 密码重置失败 请检查上方报错
  pause
  exit /b 1
)
echo.
echo   [成功] 请记下上面的密码 然后重启服务生效
pause
exit /b 0

:GENERATE
node tools/reset-admin-password.cjs --random
if errorlevel 1 (
  echo.
  echo   [失败] 密码重置失败 请检查上方报错
  pause
  exit /b 1
)
echo.
echo   [成功] 随机密码已显示在上方 请立刻抄下来
echo          然后重启服务生效
pause
exit /b 0