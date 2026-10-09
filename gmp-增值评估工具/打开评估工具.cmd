@echo off
chcp 65001 > nul
title GMP 落地增值评估工具
setlocal enabledelayedexpansion

set "ROOT=%~dp0"
set "PORT=8780"
set "URL=http://127.0.0.1:%PORT%/"

echo.
echo   ================================================
echo     新版GMP 落地增值评估工具
echo   ================================================
echo.
echo     本机地址：%URL%
echo.

REM ---- 0. 取本机局域网 IP（用于「发给别人用」）----
set "LANIP="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=* delims= " %%b in ("%%a") do (
    set "CAND=%%b"
    if "!CAND:~0,4!"=="192." set "LANIP=!CAND!"
    if "!CAND:~0,3!"=="10." set "LANIP=!CAND!"
    if "!CAND:~0,8!"=="172.16." set "LANIP=!CAND!"
    if "!CAND:~0,11!"=="172.20." set "LANIP=!CAND!"
    if "!CAND:~0,11!"=="172.21." set "LANIP=!CAND!"
    if "!CAND:~0,11!"=="172.22." set "LANIP=!CAND!"
    if "!CAND:~0,11!"=="172.29." set "LANIP=!CAND!"
    if "!CAND:~0,11!"=="172.30." set "LANIP=!CAND!"
    if "!CAND:~0,11!"=="172.31." set "LANIP=!CAND!"
  )
)
if defined LANIP (
  echo     局域网地址：http://%LANIP%:%PORT%/
  echo                ^<-- 这个才是发给同事的地址
) else (
  echo     局域网地址：未取到，请手动查看（ipconfig 里IPv4 地址）
)

REM ---- 检查防火墙是否放行 8780（不通就提示，避免发出去别人打不开）----
netsh advfirewall firewall show rule name="GMP Audit Tool 8780" > nul 2>&1
if errorlevel 1 (
  echo.
  echo   [!] 防火墙尚未放行 %PORT% 端口，其他电脑可能打不开。
  echo       需要「以管理员身份运行」本文件一次即可自动放行，
  echo       或手动添加：netsh advfirewall firewall add rule
  echo                  name="GMP Audit Tool 8780" dir=in action=allow
  echo                  protocol=TCP localport=%PORT% profile=any
)
echo.

REM ---- 1. 检查服务是否已在运行 ----
curl -s -o nul --max-time 3 "%URL%api/health" > nul 2>&1
if not errorlevel 1 goto open

REM ---- 2. 未运行：检查依赖 ----
if not exist "%ROOT%server\node_modules" (
  echo   [错误] 后端依赖未安装，请先双击 首次安装.cmd
  pause
  exit /b 1
)

REM ---- 3. 启动后端（隐藏窗口）----
echo   正在启动服务，首次约需 10 秒...
start "GMP评估服务" /min cmd /c "cd /d "%ROOT%server" && npx tsx src/index.ts"

REM ---- 4. 轮询等待就绪 ----
set /a tries=0
:wait
timeout /t 2 /nobreak > nul
curl -s -o nul --max-time 2 "%URL%api/health" > nul 2>&1
if not errorlevel 1 goto open
set /a tries+=1
if %tries% lss 20 goto wait

echo.
echo   [错误] 服务启动超时，请手动运行以查看报错：
echo     cd server && npx tsx src/index.ts
echo.
pause
exit /b 1

:open
echo   服务已就绪，正在打开浏览器...
echo.
start "" "%URL%"
echo   账号提示：
echo     管理员   admin      密码见 server/.env 的 DEFAULT_ADMIN_PASSWORD
echo     组长     随计划自动创建，首次登录请在登录页「注册账号」设置手机号与密码
echo     审核员   直接输入姓名登录；注册过的需填密码
echo.
pause