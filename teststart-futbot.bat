@echo off
cd /d "%~dp0"

if not exist "node_modules\" (
    echo node_modules nicht gefunden - installiere Abhaengigkeiten...
    call npm install
    if errorlevel 1 (
        echo npm install fehlgeschlagen!
        pause
        exit /b 1
    )
)

echo Starting Futbot...
node index.js
pause
