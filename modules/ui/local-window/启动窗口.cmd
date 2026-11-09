@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动本地窗口（仅监听 127.0.0.1）...
start "local-window" /min cmd /c "node server.mjs"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Milliseconds 1500; Start-Process 'http://127.0.0.1:8790/'"
echo 已尝试打开 http://127.0.0.1:8790/ ；若未弹出，请手动打开该地址。