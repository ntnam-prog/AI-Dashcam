@echo off
cd /d "%~dp0"
echo === DistanceADAS AI files ===
for %%F in (vendor\tf.min.js vendor\coco-ssd.min.js models\coco-ssd\model.json models\coco-ssd\group1-shard1of5 models\coco-ssd\group1-shard2of5 models\coco-ssd\group1-shard3of5 models\coco-ssd\group1-shard4of5 models\coco-ssd\group1-shard5of5) do (
  if exist "%%F" (echo OK    %%F) else (echo THIEU %%F)
)
pause
