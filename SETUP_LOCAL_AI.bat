@echo off
setlocal EnableExtensions
cd /d "%~dp0"
echo ================================================
echo DistanceADAS v1.0 beta.1 - Cai AI cuc bo
 echo ================================================
where powershell >nul 2>&1 || (
  echo KHONG TIM THAY POWERSHELL.
  pause
  exit /b 1
)
mkdir vendor 2>nul
mkdir models 2>nul
mkdir models\coco-ssd 2>nul

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
 "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';" ^
 "function GetFile($u,$o){ Write-Host ('Tai: '+$o); Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $o };" ^
 "GetFile 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js' 'vendor/tf.min.js';" ^
 "GetFile 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3' 'vendor/coco-ssd.min.js';" ^
 "GetFile 'https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/model.json' 'models/coco-ssd/model.json';" ^
 "1..5 | ForEach-Object { $n=$_; GetFile ('https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/group1-shard'+$n+'of5') ('models/coco-ssd/group1-shard'+$n+'of5') };"

if errorlevel 1 (
  echo.
  echo LOI: Khong tai duoc mot hoac nhieu file AI.
  echo Kiem tra Internet, firewall, VPN/proxy roi chay lai file nay.
  pause
  exit /b 1
)

echo.
echo KIEM TRA FILE...
for %%F in (vendor\tf.min.js vendor\coco-ssd.min.js models\coco-ssd\model.json models\coco-ssd\group1-shard1of5 models\coco-ssd\group1-shard2of5 models\coco-ssd\group1-shard3of5 models\coco-ssd\group1-shard4of5 models\coco-ssd\group1-shard5of5) do (
  if not exist "%%F" (
    echo THIEU: %%F
    pause
    exit /b 1
  )
)
echo.
echo HOAN TAT. AI da duoc luu trong thu muc DistanceADAS.
echo Bay gio chay RUN_DISTANCEADAS.bat.
pause
