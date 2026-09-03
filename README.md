# DistanceADAS Web v1.1 beta.6R3

Nền chuẩn: v1.1 beta.6.

Mục tiêu R3: ưu tiên tuyệt đối xe nằm trong làn của camera, kể cả xe xa; nếu có xe chèn ngang vào làn và trở thành vật cản gần hơn thì khóa chuyển sang xe chèn; sau khi khóa mới dùng điểm tiếp xúc mặt đường/mask để cập nhật khoảng cách.

## Kiến trúc R3

1. FAR WATCH 30%: quét vùng 30% chiều rộng quanh tâm làn, từ gần đường chân trời xuống vùng xa. ROI được phóng lên 640 px để tăng số pixel của xe ở xa, đặc biệt truck/bus >100 m.
2. Detector nhanh beta.6 vẫn là lớp phát hiện tức thời/fallback để app chạy ngay.
3. YOLO11n-seg được nạp nền khi có Internet. Khi sẵn sàng, nó chạy thưa hơn detector nhanh để lấy mask thân xe và điểm đáy mask; nếu ONNX/YOLO không nạp được thì app tự fallback, không làm camera dừng.
4. Tracking giữ xe qua các frame bằng bbox/tâm/kích thước. Mask mới được cập nhật vào track khi YOLO trả kết quả.
5. Khoảng cách hợp nhất road-plane + kích thước phương tiện + alpha-beta temporal filter; khi có segmentation, ground point lấy từ đáy mask thay vì đáy bbox.
6. Chỉ vẽ xe LEAD bằng màu đỏ. Khi có mask hợp lệ, đường đỏ ôm theo vùng mask; nếu chưa có mask thì dùng bbox đỏ.

## FAR WATCH

- Chiều rộng: 30% khung hình.
- Tâm ROI: bám theo tâm ego-lane khi AUTO LANE đã có dữ liệu; nếu chưa có thì nội suy từ điểm tụ/tâm làn cấu hình.
- Tần suất: 2/3 lượt detector nhanh ưu tiên FAR WATCH; 1/3 lượt dành cho toàn cảnh/YOLO segmentation.
- Ngưỡng FAR thấp hơn toàn cảnh để không bỏ xe xa, nhưng vẫn chỉ chấp nhận car/truck/bus/motorcycle.

## YOLO segmentation

R3 dùng ONNX Runtime Web và YOLO11n-seg qua mạng. Model không được đóng gói trong ZIP để gói GitHub nhỏ và để app vẫn dùng được ngay với bộ AI beta.6 hiện có. Khi muốn chạy YOLO hoàn toàn offline, cần đưa `ort` + model ONNX vào repo và đổi URL sang file local.

## GitHub Pages

Khi cập nhật R3, thay `index.html`, `app.js`, `style.css`, `sw.js`; giữ nguyên `models/`, `vendor/`, `icons/` đang có trong repo. Service Worker R3 dùng cache key mới và xóa cache cũ khi activate.

## Lưu ý nghiên cứu

Đây là prototype camera-only, không phải ADAS được chứng nhận và không dùng để quyết định phanh/né tránh. Khoảng cách rất xa gần đường chân trời vẫn nhạy với sai số 1–2 pixel, độ dốc mặt đường, FOV/crop của video và vị trí gá camera. Cần hiệu chuẩn bằng các mốc thực 20/40/60/100 m để giảm sai số trên đúng camera sử dụng.
