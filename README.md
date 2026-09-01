# DistanceADAS Web v0.2

Phiên bản 2 tiếp tục theo hướng ADAS vision-only, nhưng vẫn giữ phạm vi phù hợp với Safari trên iPhone 11 Pro Max.

## Thay đổi chính so với v0.1
- Chọn "lead vehicle" theo một hành lang làn đường phối cảnh thay vì chỉ chọn xe gần tâm ảnh.
- Theo dõi lead qua nhiều frame và làm mượt khoảng cách để giảm nhảy số.
- Có cơ chế giữ lead ngắn hạn khi AI mất 1–2 frame.
- Hiển thị trạng thái LEAD / LANE / SIDE.
- Sửa vòng lặp camera/AI để tránh tạo nhiều requestAnimationFrame sau khi bật-tắt nhiều lần.
- Sửa resize canvas để không reset canvas liên tục khi kích thước không đổi.
- Sửa service worker theo network-first cho file app, giảm lỗi Safari giữ JS cũ sau khi cập nhật.
- Tăng số detection tối đa và lọc candidate bị lệch ngoài màn hình.
- Thêm reset calibration và tham số độ rộng làn/làm mượt.

## Kiến trúc hiện tại
Camera Safari
→ COCO-SSD lite MobileNet
→ lọc vehicle
→ lane corridor hình học
→ chọn lead vehicle
→ tracking/làm mượt
→ pinhole-ground approximation
→ overlay khoảng cách

## Điều chưa có trong v0.2
- Chưa chạy OpenPilot Supercombo trong Safari.
- Chưa có neural lane segmentation/model lane chuyên dụng.
- Chưa có optical flow hay TTC tin cậy.
- Chưa có tốc độ xe từ GPS.
- Chưa đủ độ tin cậy để dùng như thiết bị an toàn.

## Hiệu chuẩn
1. Gá iPhone cố định trên xe.
2. Đỗ nơi bằng phẳng và an toàn.
3. Chỉnh đường đỏ trùng horizon.
4. Chọn một điểm/vạch mặt đường có khoảng cách đã biết.
5. Chỉnh đường vàng qua điểm đó và nhập khoảng cách thực.
6. Điều chỉnh "Độ rộng làn ở đáy ảnh" sao cho hai đường xanh ôm đúng làn xe đang chạy.
7. Lưu.

## Công thức khoảng cách
D = K / (y - yh)

K được tính từ một điểm chuẩn có khoảng cách biết trước.

## Lưu ý an toàn
Đây là prototype nghiên cứu. Không dùng để thay thế quan sát, phanh, radar/camera ADAS của xe hay các hệ thống an toàn được chứng nhận.
