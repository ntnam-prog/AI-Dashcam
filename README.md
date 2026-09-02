# DistanceADAS Web v1.0 beta.1

Bản sửa lỗi AI loading của v1.0 beta.

## Điểm mới

- Không còn treo vô hạn ở `Đang tải AI...`.
- Tách lỗi camera và lỗi AI.
- Ưu tiên TensorFlow.js + COCO-SSD + model AI cục bộ.
- Nếu file local chưa có, app vẫn thử CDN/Google model với timeout rõ ràng.
- Hiển thị nguồn model `LOCAL` hoặc `NET` cạnh backend TensorFlow.
- Camera vẫn giữ hình khi AI nạp lỗi để chẩn đoán dễ hơn.

## Windows - lần đầu

1. Giải nén toàn bộ thư mục.
2. Chạy `SETUP_LOCAL_AI.bat` một lần để tải thư viện và model AI vào máy.
3. Chạy `RUN_DISTANCEADAS.bat`.
4. Mở Chrome: `http://localhost:8080`
5. Bấm `BẬT CAMERA`.

Khi thành công, góc phải sẽ hiện kiểu `TF webgl • LOCAL` hoặc `TF cpu • LOCAL`, và trạng thái sẽ chuyển sang `Đang đo khoảng cách`.

## Cấu trúc AI local

`vendor/` chứa TensorFlow.js và thư viện COCO-SSD.

`models/coco-ssd/` chứa `model.json` và 5 shard trọng số.

## Lưu ý

DistanceADAS là prototype nghiên cứu, không phải hệ thống ADAS được chứng nhận và không được dùng làm căn cứ duy nhất để phanh/tránh va chạm.
