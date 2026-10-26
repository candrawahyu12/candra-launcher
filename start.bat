@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul || (echo Python belum terpasang. Unduh dari https://www.python.org/downloads/ lalu centang "Add python.exe to PATH". & pause & exit /b 1)
echo Menjalankan CANDRA di http://127.0.0.1:8765 ... (tutup jendela ini untuk berhenti)
start "" http://127.0.0.1:8765
python server.py
pause
