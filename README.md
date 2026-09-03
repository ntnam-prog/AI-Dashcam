DistanceADAS Web v1.1 beta.6R1
CENTER-LANE LOCK + ADVANCED DISTANCE

Nền mã: v1.1 beta.6, giữ nguyên detector COCO-SSD lite_mobilenet_v2 và pipeline FULL / ZOOM-L / ZOOM-R vốn chạy nhanh trên iPhone.

Mục tiêu bản R1:
- Chỉ vẽ 1 box đỏ: xe thực sự đang ở phía trước trong hành lang làn của camera.
- Xe xa hay gần đều được xét theo hình học làn tại đúng cao độ của xe.
- Khi xe bên cạnh chèn vào làn và trở thành vật cản gần hơn, khóa chuyển ngay sang xe chèn.
- Không dùng ID/lane label trên box; nhãn chỉ là XE TRƯỚC • xx m.
- Tracking giữ identity bằng IoU + tâm dự đoán + kích thước + lớp xe.
- Khoảng cách dùng road-plane calibration làm nguồn chính, có kiểm tra chéo bằng kích thước phương tiện và bộ lọc alpha-beta theo thời gian để giảm nhảy số.
- AUTO GEOMETRY được phép chạy cả camera thật và VIDEO THỬ để bám đường chân trời tốt hơn.

Lưu ý quan trọng:
Camera đơn mắt không thể bảo đảm khoảng cách tuyệt đối như radar/LiDAR. VIDEO THỬ đặc biệt có thể sai số nếu chiều cao camera/FOV của video nguồn khác cấu hình. Để hiệu chỉnh số mét thực tế, nên kiểm tra tại các mốc 20/40/60/100 m với đúng vị trí gá camera.

Research prototype only. Không dùng như hệ thống phanh/cảnh báo va chạm được chứng nhận.
