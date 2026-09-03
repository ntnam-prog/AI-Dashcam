# DistanceADAS Web v1.1 beta.6R2 — WIDE LOCK + TELE DISTANCE

Nền: v1.1 beta.6R1 ổn định.

Luồng chính:
1. WIDE luôn mở, nhận làn và khóa duy nhất xe trước mặt.
2. Khoảng cách vẫn được tính/hiển thị liên tục từ WIDE.
3. Khi xe >= ~85 m ổn định ~0.9 s, app thử mở TELE song song nếu Safari công khai một camera tele riêng.
4. WIDE vẫn giữ quyền LOCK. TELE chỉ quan sát mục tiêu ở vùng trung tâm và tạo phép đo xa bổ sung.
5. TELE measurement được tự neo vào khoảng cách WIDE lúc bắt đầu, sau đó theo dõi biến thiên kích thước xe trên tele; ở 90–140 m trọng số TELE tăng dần.
6. Khi xe <= ~65 m, TELE tự tắt để giảm tải/nhiệt.
7. Nếu TELE không mở được, app tự fallback WIDE và không dừng camera chính.

Lưu ý nghiên cứu:
- Web/Safari không đảm bảo mọi iPhone/điện thoại sẽ công khai camera tele vật lý như một deviceId độc lập hoặc cho hai camera chạy đồng thời.
- Nhánh TELE hiện là TELE-assist thực nghiệm, chưa phải model AI distance đã huấn luyện. Khoảng cách tuyệt đối vẫn dựa trên lõi R1; TELE chủ yếu tăng độ nhạy biến thiên khi mục tiêu ở xa.
- Không dùng cho điều khiển xe/phanh; đây là prototype nghiên cứu.
