@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没找到 node。先装 Node.js 18 或更高版本：https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo.
echo   矛盾分析室 / Contradiction Lab
echo   http://localhost:3000
echo.
echo   关闭这个窗口即停止服务。
echo   要用本地模型（Ollama / LM Studio），先在启动前执行： set MAODUN_ALLOW_PRIVATE=1
echo.

start "" /b cmd /c "ping -n 3 127.0.0.1 >nul && start http://localhost:3000"
node server.js
pause
