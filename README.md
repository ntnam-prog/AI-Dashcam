DistanceADAS Web v1.1 beta.6R2

MULTI-METHOD DISTANCE FUSION

Nền mã: v1.1 beta.6R1. Phần DETECT / LOCK / TRACK giữ nguyên hướng đã chốt; R2 chỉ nâng cấp engine khoảng cách.

Pipeline khoảng cách:
BOX đúng xe -> road-plane distance -> vehicle-size distance -> motion prediction -> confidence fusion -> adaptive alpha-beta filter -> hiển thị mét.

Điểm mới:
- Road-plane vẫn là nguồn hình học chính.
- Vehicle-size dùng cả chiều rộng và chiều cao box, có kiểm tra độ nhất quán.
- Tính confidence riêng cho road-plane và size-depth theo vị trí so với horizon, độ ổn định AUTO GEOMETRY, kích thước pixel và mức đồng thuận giữa các phương pháp.
- Motion prediction chỉ là nguồn phụ để giữ số mét liên tục giữa các lần AI detect.
- Fusion giảm trọng số nguồn nào đang mâu thuẫn mạnh; ở khoảng cách xa ưu tiên road-plane hơn size prior.
- Adaptive alpha-beta filter có outlier gate để giảm nhảy số khi box detector thay đổi đột ngột.
- Không cần hiệu chuẩn 20/40/60/100 m trước khi chạy. Hiệu chuẩn thực địa có thể làm sau để giảm bias tuyệt đối cho đúng camera/góc gá.

Lưu ý an toàn: đây là prototype nghiên cứu camera đơn, không thay thế radar/LiDAR và không dùng làm căn cứ duy nhất cho phanh/tránh va chạm.
