# DistanceADAS v1.1 beta.6R2-LANDSCAPE-LABELFIX

Nền: đúng v1.1 beta.6R2 WIDE LOCK + TELE DISTANCE. Không có Depth Anything/AI-depth mới.

Thay đổi duy nhất đáng kể: LANDSCAPE SAFE. Khi điện thoại xoay dọc/ngang, app tạm dừng inference khoảng dưới 1 giây, đọc lại viewport/video, resize overlay, xóa track theo hệ tọa độ cũ, reset AUTO LANE/AUTO GEOMETRY và tự khóa lại xe. TELE assist được tắt khi xoay và chỉ tự mở lại khi xe xa theo logic R2.

Mục tiêu: giữ độ ổn định/tốc độ của R2, sửa lỗi box và khoảng cách sai sau khi xoay điện thoại.


## LABEL FIX
- Nhãn `XE TRƯỚC • xx m` mặc định đặt 12 px dưới đáy box xe.
- Nếu xe quá sát mép dưới, nhãn tự chuyển lên trên box để không đè vùng điều khiển.
- Giữ nguyên lõi WIDE LOCK + TELE DISTANCE + LANDSCAPE SAFE.
