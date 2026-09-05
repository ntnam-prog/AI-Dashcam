# DistanceADAS v1.1 beta.6R2 – EGOLOCK-CALDIST-WEB-LITE

Nhánh thử nghiệm WEB-LITE, tách khỏi baseline `DISPLAYFIX-EGOLOCK`.

Mục tiêu: giữ Safari/PWA nhẹ, không thêm model depth/segmentation, nhưng tăng chất lượng LOCK và khoảng cách bằng hình học + cảm biến web.

Pipeline:
`LANE (3 làn) -> EGOLOCK/CUT-IN -> GROUND CONTACT -> D_ground + D_size + D_TELE -> FUSION -> TEMPORAL FILTER/HOLD -> D_final + QUALITY -> DISPLAY`

Điểm chính:
- 3 làn cố định; AUTO LANE chỉ xét mô hình 3 làn.
- CUT-IN state machine: ENTER 20%, EXIT 10%, xác nhận 3 frame, release hold 320 ms.
- Distance không tham gia chọn target.
- Ground contact lấy vùng đáy bbox, không segmentation.
- Camera Profile lưu theo camera + độ phân giải.
- Web IMU assist: DeviceOrientation chỉ dùng để bù thay đổi pitch/horizon ngắn hạn, giới hạn ±3% chiều cao ảnh; nếu không được cấp quyền thì tự fallback, app vẫn chạy.
- D_ground là nguồn chính; D_size và D_TELE cross-check/fusion.
- TELE chạy thưa (`650 ms`) và chỉ bật khi xe xa.
- Filter chỉ giữ 5 mẫu distance/track; visual hold 720 ms.
- Track cache giới hạn 12 đối tượng; chỉ một LEAD được hiển thị/đo chính.
- QUALITY theo rule/consensus, không neural network.

Lưu ý: Đây là geometry web nhẹ, không phải ARKit native. Số mét vẫn cần kiểm chứng/hiệu chuẩn ngoài đường; không dùng như hệ thống phanh/cảnh báo an toàn đã chứng nhận.
