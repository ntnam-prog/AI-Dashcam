# DistanceADAS v1.1 beta.6R2-DA80-AI

- Giữ nền ổn định beta.6/R1: WIDE khóa duy nhất xe cùng làn.
- TELE chỉ hỗ trợ đo xa khi Safari cho phép.
- Thêm Depth Anything V2 Small chạy trực tiếp trong browser bằng Transformers.js/ONNX, chỉ inference ROI của xe đã khóa để giảm tải.
- WebGPU nếu có; nếu không có thì WASM.
- 0–80 m hiển thị số; trên 80 m hiển thị `>80 m`.
- AI depth chạy thưa (~1.2 s/lần) để giảm nhiệt.

Lưu ý: checkpoint chính thức Depth Anything V2 Metric Outdoor Small hiện là Transformers/Safetensors và chưa có ONNX browser-ready chính thức. Bản này dùng DAV2 Small ONNX làm tín hiệu AI-depth thật trong Safari và neo metric vào estimate hiện tại; không giả mạo là checkpoint Metric Outdoor trực tiếp. Khi có/convert được Metric Outdoor ONNX, chỉ thay model, giữ nguyên pipeline WIDE→TELE→AI.

Lần đầu cần Internet để tải Transformers.js/model; trình duyệt sẽ cache model.
