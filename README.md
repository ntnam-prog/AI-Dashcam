# DistanceADAS v1.1 beta.6R2-FIX1

Nền: v1.1 beta.6/R1. Bản sửa tập trung hai lỗi trên Safari/iPhone:

- LANDSCAPE SAFE: khi xoay màn hình, tạm ngắt inference ngắn, đọc lại viewport/video, xóa track cũ, reset AUTO LANE/AUTO GEOMETRY rồi khóa lại xe trước.
- MEMORY SAFE AI DEPTH: COCO detection, TELE assist và Depth Anything không inference chồng nhau; AI depth chạy thưa hơn và ROI giảm xuống 224 px để giảm peak memory.
- WIDE vẫn quyết định duy nhất xe cùng làn; TELE/AI depth chỉ hỗ trợ khoảng cách.
- 0–80 m hiển thị số; >80 m hiển thị >80 m.
- Nếu TELE không mở được, tự fallback WIDE.

Đây vẫn là prototype nghiên cứu camera-only, không phải hệ thống ADAS được chứng nhận.
