@echo off
chcp 65001 >nul
title MineYou M3 — Bảng Điều Khiển Minecraft (Windows 11)
color 0A

echo.
echo  ╔════════════════════════════════════════════════════════╗
echo  ║     MineYou M3 — Web Panel Minecraft (Material 3)     ║
echo  ║     Hỗ trợ: PC Java + Mobile Bedrock + Crack         ║
echo  ╚════════════════════════════════════════════════════════╝
echo.

:: Kiểm tra Node.js
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
  echo  [LỖI] Chưa cài Node.js! Tải tại: https://nodejs.org/en/download
  echo  [LỖI] Cài Node.js LTS xong rồi chạy lại file này.
  pause
  exit /b 1
)

for /f "tokens=1,2,3 delims=." %%a in ('node -v') do set NODE_MAJOR=%%a
set NODE_MAJOR=%NODE_MAJOR:v=%
if %NODE_MAJOR% LSS 18 (
  echo  [CẢNH BÁO] Phiên bản Node.js quá cũ (v%NODE_MAJOR%). Khuyên dùng v20 LTS+.
)

:: Kiểm tra Java (dùng để chạy Minecraft Server)
where java >nul 2>&1
if %ERRORLEVEL% neq 0 (
  echo  [CẢNH BÁO] Chưa cài Java 21! Cần Java để chạy Minecraft Server.
  echo  [CẢNH BÁO] Tải tại: https://adoptium.net/temurin/releases/?version=21
  echo  [INFO] Web Panel vẫn sẽ khởi động. Cài Java trước khi bấm "Khởi động Server".
  echo.
) else (
  echo  [OK] Java đã cài.
)

:: Cài thư viện Node.js nếu chưa có
if not exist node_modules (
  echo  [Hệ thống] Đang cài thư viện Node.js (lần đầu chạy)...
  call npm install
  if %ERRORLEVEL% neq 0 (
    echo  [LỖI] npm install thất bại! Kiểm tra kết nối Internet.
    pause
    exit /b 1
  )
  echo  [OK] Đã cài xong thư viện.
)

:: Tạo thư mục mc_server nếu chưa có
if not exist mc_server (
  mkdir mc_server
  mkdir mc_server\plugins
  echo  [Hệ thống] Đã tạo thư mục mc_server\
)

echo.
echo  [Hệ thống] Đang khởi động Web Panel tại http://localhost:3000 ...
echo  [Hệ thống] Nhấn Ctrl+C để tắt server khi không dùng nữa.
echo.

:: Mở trình duyệt sau 2 giây (chờ server khởi động)
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"

:: Chạy Node.js backend
node server.js

echo.
echo  [Hệ thống] Web Panel đã tắt.
pause
