# Hướng Dẫn Chạy MineYou Material 3 Web Panel Trên Windows 11

## 1. Yêu cầu cài đặt trên Windows 11
1. **Java 21 (Adoptium Temurin):** Tải tại https://adoptium.net/ hoặc cài nhanh qua PowerShell (Run as Administrator):
   ```powershell
   winget install EclipseAdoptium.Temurin.21.JDK --accept-package-agreements --accept-source-agreements
   ```
2. **Node.js (Bản LTS):** Tải tại https://nodejs.org/ để chạy giao diện điều khiển Web Material Design 3.

## 2. Cách khởi động Web Panel
1. Bấm đúp vào file **`start_web_panel.bat`**.
2. Trình duyệt sẽ tự động mở địa chỉ `http://localhost:3000` với giao diện **Google Material Design 3**.
3. **Quy trình 3 bước bắt buộc**:
   - **Bước 1**: Chọn phiên bản Minecraft mong muốn.
   - **Bước 2**: Bấm nút **"⚡ Tạo Tài Nguyên Cho Phiên Bản Này"** (chờ tải đủ 100% nhân JAR và các Plugin).
   - **Bước 3**: Bấm **"Khởi động Server"** tại trang Tổng quan.

## 3. Khắc phục lỗi thường gặp
- **Lỗi `spawn java ENOENT` (Mã `-4058`)**: Do máy tính chưa cài Java 21 hoặc chưa nhận biến môi trường PATH. Chạy lệnh winget ở mục 1, sau đó tắt cửa sổ Web Panel và bật lại `start_web_panel.bat`.
- **Lỗi thiếu file JAR khi bấm Khởi động**: Do bạn chưa bấm **"Tạo Tài Nguyên"** ở Bước 2.

## 4. Thiết lập Chơi Chung PC + Mobile + Crack & Mạng Kép
- **Chọn phiên bản:** Trong mục **Chọn Phiên Bản**, các bản có gắn nhãn **`💻 PC + 📱 Mobile`** sẽ tự động dùng **PaperMC + GeyserMC + Floodgate + ViaVersion**.
- **Tối ưu 8GB RAM cho 4 người chơi:** Để thanh trượt RAM ở mức **3.5 GB - 4.0 GB** (nếu bạn vừa host vừa mở game chơi trên cùng máy Win 11 thì chọn **3.5 GB**).
- **Chạy song song Playit.gg & Mở Port:**
  - Mở Port trên Router Wi-Fi: **TCP `25565`** (cho PC Java) và **UDP `19132`** (cho Mobile PE).
  - Đồng thời chạy `playit.exe` hoặc plugin `playit-minecraft-plugin.jar` để tạo thêm 2 đường hầm (1 cho Java TCP 25565, 1 cho Bedrock UDP 19132). Cả 2 cách kết nối sẽ hoạt động song song cùng lúc!
