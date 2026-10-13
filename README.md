# AmbiMusic PRO – bản web (Vercel)

Thư mục này chỉ chứa giao diện web (file tĩnh). Không có bí mật nào ở đây.

- `vercel.json` chuyển mọi yêu cầu `/api/...` sang server Python của bạn.
  Nếu địa chỉ server đổi, sửa dòng `destination` cho khớp (giữ nguyên phần `/api/:path*`).
- Triển khai: đưa thư mục này lên một repo GitHub rồi Import vào Vercel
  (Framework Preset: Other, không cần Build Command), hoặc chạy `npx vercel --prod` trong thư mục này.
- Kiểm tra sau khi deploy: mở `https://<tên-app>.vercel.app/api/status`. Thấy JSON có `"server":"ambimusic"` là thông.
