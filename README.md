# DistanceADAS v1.1 beta.6R2-DISPLAYFIX-EGOLOCK

Nền: v1.1 beta.6R2-DISPLAYFIX.

Bản này sửa riêng bộ chọn xe trước mặt, không thay detector/tracker WIDE+TELE:

- Chỉ khóa duy nhất xe thực sự chiếm ego-lane.
- Điểm xét là vùng đuôi/đáy xe; không dùng toàn bounding-box để tránh xe làn bên lấn box vào làn mình.
- Xe bình thường phải có tâm đuôi nằm trong lõi ego-lane.
- Xe chèn ngang chỉ được cướp LOCK khi thân xe đã đi vào phần lớn ego-lane.
- Chọn xe gần nhất phía trước bằng thứ tự phối cảnh (bottom-y), KHÔNG dùng khoảng cách ước lượng để quyết định xe nào được khóa.
- Giữ LOCK hiện tại để tránh nhảy mục tiêu; chỉ chuyển khi xe khác rõ ràng ở phía trước/cắt vào làn.
- Giữ DISPLAYFIX: khoảng cách không nhấp nháy ngắn hạn và nhãn cách đáy box 12 px.

Mục tiêu: LANE -> VEHICLE -> LOCK -> DISTANCE.
