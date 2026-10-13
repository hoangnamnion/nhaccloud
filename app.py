"""
AmbiMusic Hub Server - Hỗ trợ file tới 2GB qua Telegram MTProto (Telethon)
========================================================================
- Giao diện Web /login: Đăng nhập Telegram trực tiếp trên trình duyệt, không cần chạy make_session.py trên máy tính.
- Tự động chuyển hướng thư mục tạm sang ổ cứng 20GB (chống lỗi No space left on device).
- Hỗ trợ Upload & Stream file nhạc tới 2000MB (2GB) qua giao thức MTProto.
"""

import asyncio
import json
import os
import platform
import re
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from flask import Flask, Response, jsonify, render_template_string, request
from flask_cors import CORS

PORT = int(os.environ.get("SERVER_PORT") or os.environ.get("PORT") or 25635)
BASE = Path(__file__).resolve().parent
DB_PATH = BASE / "ambimusic.db"
CONFIG_PATH = BASE / "config.json"
COVER_DIR = BASE / "covers"
COVER_DIR.mkdir(parents=True, exist_ok=True)

# Chống lỗi [Errno 28] No space left on device: ép tempfile dùng ổ 20GB của container
TMP_DIR = BASE / "tmp"
TMP_DIR.mkdir(parents=True, exist_ok=True)
tempfile.tempdir = str(TMP_DIR)
os.environ["TMPDIR"] = str(TMP_DIR)
os.environ["TEMP"] = str(TMP_DIR)
os.environ["TMP"] = str(TMP_DIR)

# Dọn dẹp file tạm cũ khi khởi động
for _old in TMP_DIR.glob("*"):
    try:
        if _old.is_file():
            _old.unlink()
    except Exception:
        pass

# Thông tin Telegram App mặc định
DEFAULT_API_ID = 33252624
DEFAULT_API_HASH = "233bfb140e08cc73b32d710043d83491"
DEFAULT_BOT_TOKEN = "8301597002:AAH3Q1blNv9bZnUZJrLDsjOgRamk1SLoFf4"
DEFAULT_CHAT_ID = "6754356446"

# Thử nạp Telethon
try:
    from telethon import TelegramClient
    from telethon.errors import SessionPasswordNeededError
    from telethon.sessions import StringSession
    from telethon.tl.types import DocumentAttributeAudio
    HAS_TELETHON = True
except ImportError:
    HAS_TELETHON = False
    print("[telethon] Chưa cài Telethon. Server sẽ chạy chế độ Bot API dự phòng.", flush=True)

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})


# ================= Cấu hình & Database =================
def load_config():
    cfg = {}
    if CONFIG_PATH.exists():
        try:
            cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"[config] Lỗi đọc config.json: {e}", flush=True)
    cfg.setdefault("api_id", DEFAULT_API_ID)
    cfg.setdefault("api_hash", DEFAULT_API_HASH)
    cfg.setdefault("access_code", "nhac123")
    cfg.setdefault("chat", "me")
    return cfg


def save_config(cfg):
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


def init_db():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("PRAGMA table_info(tracks)")
    cols = {r[1]: r[2] for r in cur.fetchall()}
    if cols and ("has_cover" not in cols or cols.get("id") != "INTEGER"):
        print("[db] Nâng cấp cấu trúc bảng tracks...", flush=True)
        cur.execute("DROP TABLE IF EXISTS tracks")
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS tracks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            artist TEXT,
            album TEXT,
            duration REAL DEFAULT 0,
            has_cover INTEGER DEFAULT 0,
            file_id TEXT,
            file_size INTEGER DEFAULT 0,
            message_id INTEGER,
            created_at INTEGER
        )
        """
    )
    conn.commit()
    conn.close()


init_db()


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


from werkzeug.exceptions import HTTPException

@app.errorhandler(Exception)
def handle_exception(e):
    if isinstance(e, HTTPException):
        return jsonify(ok=False, error=f"{e.code} {e.name}: {e.description}"), e.code
    traceback.print_exc()
    return jsonify(ok=False, error=f"Server lỗi: {str(e)}"), 500


# ================= Telethon Client Manager =================
class TelethonManager:
    def __init__(self):
        self.client = None
        self.me = None
        self.ready = False
        self.premium = False
        self.error = "Chưa đăng nhập Telegram (mở /login trên trình duyệt để kết nối)"
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self._run_loop, daemon=True, name="telethon-worker")
        self.thread.start()

    def _run_loop(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def run(self, coro, timeout=120):
        future = asyncio.run_coroutine_threadsafe(coro, self.loop)
        return future.result(timeout)

    def start_from_config(self):
        if not HAS_TELETHON:
            self.error = "Chưa cài telethon trên server (hãy thêm telethon vào requirements.txt)"
            return
        cfg = load_config()
        session_str = cfg.get("session")
        if not session_str:
            self.ready = False
            self.error = "Chưa có session (vào link /login để đăng nhập)"
            return
        asyncio.run_coroutine_threadsafe(self._connect_client(cfg), self.loop)

    async def _connect_client(self, cfg):
        try:
            print("[telethon] Đang kết nối tới Telegram...", flush=True)
            self.client = TelegramClient(
                StringSession(cfg["session"]),
                int(cfg.get("api_id") or DEFAULT_API_ID),
                str(cfg.get("api_hash") or DEFAULT_API_HASH)
            )
            await self.client.connect()
            if not await self.client.is_user_authorized():
                self.ready = False
                self.error = "Phiên đăng nhập hết hạn. Mở lại /login để quét mã/nhập OTP."
                print("[telethon] Phiên đăng nhập hết hạn!", flush=True)
                return
            self.me = await self.client.get_me()
            self.premium = bool(getattr(self.me, "premium", False))
            self.ready = True
            self.error = None
            print(f"[telethon] Đăng nhập thành công: {self.me.first_name} (Hạn mức file 2GB sẵn sàng!)", flush=True)
        except Exception as e:
            self.ready = False
            self.error = f"Lỗi kết nối Telegram: {e}"
            print(f"[telethon] Lỗi: {e}", flush=True)


tele_mgr = TelethonManager()
tele_mgr.start_from_config()

# Lưu trữ tạm phiên xác thực OTP khi người dùng đăng nhập qua web
_auth_states = {}


# ================= Giao diện Web /login =================
LOGIN_HTML = """
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Đăng nhập Telegram - AmbiMusic Server (2GB)</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    body { background:#0a0b10; color:#fff; display:flex; align-items:center; justify-content:center; min-height:100vh; padding:20px; }
    .card { background:rgba(20,24,38,0.85); border:1px solid rgba(255,255,255,0.1); border-radius:18px; padding:32px; width:100%; max-width:440px; box-shadow:0 20px 40px rgba(0,0,0,0.6); backdrop-filter:blur(20px); }
    h2 { font-size:1.4rem; margin-bottom:8px; display:flex; align-items:center; gap:10px; }
    p.sub { font-size:0.85rem; color:#94a3b8; line-height:1.5; margin-bottom:24px; }
    .form-group { margin-bottom:16px; }
    label { display:block; font-size:0.82rem; font-weight:600; color:#cbd5e1; margin-bottom:6px; }
    input { width:100%; background:rgba(0,0,0,0.4); border:1px solid rgba(255,255,255,0.15); border-radius:10px; padding:12px 14px; color:#fff; font-size:0.95rem; outline:none; transition:0.2s; }
    input:focus { border-color:#38bdf8; box-shadow:0 0 10px rgba(56,189,248,0.3); }
    .btn { width:100%; padding:12px; background:linear-gradient(135deg, #6366f1, #a855f7); border:none; border-radius:10px; color:#fff; font-weight:700; font-size:0.95rem; cursor:pointer; margin-top:8px; transition:0.2s; }
    .btn:hover { opacity:0.9; transform:scale(0.99); }
    .btn:disabled { opacity:0.5; cursor:not-allowed; }
    .alert { padding:10px 14px; border-radius:8px; font-size:0.82rem; margin-bottom:16px; line-height:1.4; display:none; }
    .alert.err { background:rgba(239,68,68,0.2); border:1px solid rgba(239,68,68,0.4); color:#fca5a5; }
    .alert.succ { background:rgba(16,185,129,0.2); border:1px solid rgba(16,185,129,0.4); color:#6ee7b7; }
    .badge { display:inline-block; padding:4px 10px; border-radius:6px; font-size:0.75rem; font-weight:600; margin-bottom:14px; }
    .badge-ok { background:rgba(16,185,129,0.2); color:#34d399; border:1px solid rgba(16,185,129,0.3); }
    .badge-warn { background:rgba(234,179,8,0.2); color:#facc15; border:1px solid rgba(234,179,8,0.3); }
  </style>
</head>
<body>
  <div class="card">
    <h2>🎵 AmbiMusic Hub (2GB)</h2>
    <p class="sub">Đăng nhập tài khoản Telegram để kích hoạt hạn mức lưu trữ và stream nhạc <strong>tối đa 2GB</strong> mỗi bài.</p>

    <div id="statusBadge"></div>
    <div id="alertBox" class="alert"></div>

    <!-- Bước 1: Gửi SĐT -->
    <div id="stepPhone">
      <div class="form-group">
        <label>Số điện thoại Telegram (kèm mã +84):</label>
        <input type="text" id="phoneInput" placeholder="+84912345678" autocomplete="tel">
      </div>
      <button class="btn" id="sendCodeBtn">Gửi mã OTP qua Telegram</button>
    </div>

    <!-- Bước 2: Nhập OTP -->
    <div id="stepCode" style="display:none;">
      <div class="form-group">
        <label>Mã OTP (Telegram vừa gửi vào app):</label>
        <input type="text" id="codeInput" placeholder="12345" autocomplete="one-time-code">
      </div>
      <div class="form-group" id="pwdGroup" style="display:none;">
        <label>Mật khẩu 2 bước (2FA nếu có):</label>
        <input type="password" id="pwdInput" placeholder="Mật khẩu Telegram của bạn">
      </div>
      <button class="btn" id="verifyBtn">Xác nhận đăng nhập (Kích hoạt 2GB)</button>
    </div>

    <!-- Bước 3: Đã đăng nhập -->
    <div id="stepDone" style="display:none; text-align:center; padding:10px 0;">
      <p style="font-size:1.1rem; color:#34d399; font-weight:bold; margin-bottom:8px;">🎉 Đã kết nối Telegram thành công!</p>
      <p style="font-size:0.85rem; color:#cbd5e1; line-height:1.6;">Server đã kích hoạt hạn mức upload & phát nhạc <strong>2GB</strong>.<br>Bây giờ bạn có thể quay lại trang nghe nhạc và tải bài hát thoải mái!</p>
    </div>
  </div>

  <script>
    const alertBox = document.getElementById('alertBox');
    function showAlert(msg, isErr=true) {
      alertBox.className = 'alert ' + (isErr ? 'err' : 'succ');
      alertBox.textContent = msg;
      alertBox.style.display = 'block';
    }

    // Kiểm tra trạng thái hiện tại
    fetch('/api/status').then(r=>r.json()).then(data => {
      const b = document.getElementById('statusBadge');
      if (data.telegram && data.telegram.ready) {
        b.innerHTML = '<span class="badge badge-ok">✅ Đã kết nối Telegram (' + (data.telegram.account || 'Sẵn sàng') + ')</span>';
        document.getElementById('stepPhone').style.display = 'none';
        document.getElementById('stepDone').style.display = 'block';
      } else {
        b.innerHTML = '<span class="badge badge-warn">⚠️ ' + (data.telegram?.error || 'Chưa đăng nhập') + '</span>';
      }
    });

    let currentPhone = '';

    document.getElementById('sendCodeBtn').addEventListener('click', async () => {
      const phone = document.getElementById('phoneInput').value.trim();
      if (!phone.startsWith('+') || phone.length < 8) {
        showAlert('Vui lòng nhập đúng định dạng số điện thoại quốc tế (Ví dụ: +84912345678)');
        return;
      }
      currentPhone = phone;
      const btn = document.getElementById('sendCodeBtn');
      btn.disabled = true;
      btn.textContent = 'Đang gửi mã...';
      try {
        const res = await fetch('/api/auth/send_code', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ phone })
        });
        const d = await res.json();
        if (d.ok) {
          showAlert('Đã gửi mã xác nhận! Vui lòng mở app Telegram để lấy mã.', false);
          document.getElementById('stepPhone').style.display = 'none';
          document.getElementById('stepCode').style.display = 'block';
        } else {
          showAlert(d.error || 'Lỗi gửi mã OTP');
          btn.disabled = false;
          btn.textContent = 'Gửi lại mã OTP';
        }
      } catch (e) {
        showAlert('Lỗi kết nối: ' + e.message);
        btn.disabled = false;
        btn.textContent = 'Gửi lại mã OTP';
      }
    });

    document.getElementById('verifyBtn').addEventListener('click', async () => {
      const code = document.getElementById('codeInput').value.trim();
      const password = document.getElementById('pwdInput').value.trim();
      if (!code) { showAlert('Vui lòng nhập mã OTP'); return; }

      const btn = document.getElementById('verifyBtn');
      btn.disabled = true;
      btn.textContent = 'Đang xác thực...';

      try {
        const res = await fetch('/api/auth/verify_code', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ phone: currentPhone, code, password })
        });
        const d = await res.json();
        if (d.ok) {
          showAlert('Đăng nhập thành công! Đã kích hoạt hạn mức 2GB.', false);
          document.getElementById('stepCode').style.display = 'none';
          document.getElementById('stepDone').style.display = 'block';
          document.getElementById('statusBadge').innerHTML = '<span class="badge badge-ok">✅ Đã kết nối Telegram (' + (d.name || '2GB') + ')</span>';
        } else if (d.need_password) {
          showAlert('Tài khoản có bật mật khẩu 2 bước (2FA). Vui lòng nhập mật khẩu bên dưới.', true);
          document.getElementById('pwdGroup').style.display = 'block';
          btn.disabled = false;
          btn.textContent = 'Xác nhận với Mật khẩu 2FA';
        } else {
          showAlert(d.error || 'Mã OTP không đúng hoặc hết hạn');
          btn.disabled = false;
          btn.textContent = 'Thử lại';
        }
      } catch (e) {
        showAlert('Lỗi kết nối: ' + e.message);
        btn.disabled = false;
        btn.textContent = 'Thử lại';
      }
    });
  </script>
</body>
</html>
"""


@app.route("/login", methods=["GET"])
@app.route("/login/", methods=["GET"])
def login_page():
    return render_template_string(LOGIN_HTML)


# ================= Auth APIs (Web Login Telegram) =================
@app.route("/api/auth/send_code", methods=["POST"])
def auth_send_code():
    if not HAS_TELETHON:
        return jsonify(ok=False, error="Chưa cài telethon trên server. Hãy kiểm tra requirements.txt."), 500

    data = request.get_json() or {}
    phone = (data.get("phone") or "").strip()
    if not phone:
        return jsonify(ok=False, error="Thiếu số điện thoại"), 400

    cfg = load_config()
    api_id = int(cfg.get("api_id") or DEFAULT_API_ID)
    api_hash = str(cfg.get("api_hash") or DEFAULT_API_HASH)

    async def _send():
        client = TelegramClient(StringSession(), api_id, api_hash)
        await client.connect()
        res = await client.send_code_request(phone)
        return client, res.phone_code_hash

    try:
        client, code_hash = tele_mgr.run(_send())
        _auth_states[phone] = {
            "client": client,
            "hash": code_hash,
            "ts": time.time()
        }
        return jsonify(ok=True)
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 400


@app.route("/api/auth/verify_code", methods=["POST"])
def auth_verify_code():
    if not HAS_TELETHON:
        return jsonify(ok=False, error="Chưa cài telethon"), 500

    data = request.get_json() or {}
    phone = (data.get("phone") or "").strip()
    code = (data.get("code") or "").strip()
    pwd = (data.get("password") or "").strip()

    st = _auth_states.get(phone)
    if not st:
        return jsonify(ok=False, error="Phiên gửi mã đã hết hạn. Vui lòng bấm gửi mã OTP lại."), 400

    client = st["client"]
    code_hash = st["hash"]

    async def _verify():
        try:
            await client.sign_in(phone=phone, code=code, phone_code_hash=code_hash)
        except SessionPasswordNeededError:
            if not pwd:
                return "need_pwd", None
            await client.sign_in(password=pwd)

        me = await client.get_me()
        session_str = client.session.save()
        return "ok", (me, session_str)

    try:
        res_type, res_data = tele_mgr.run(_verify())
        if res_type == "need_pwd":
            return jsonify(ok=False, need_password=True, error="Yêu cầu mật khẩu 2 bước (2FA)"), 200

        me, session_str = res_data
        cfg = load_config()
        cfg["session"] = session_str
        save_config(cfg)

        # Kích hoạt luôn client chính
        tele_mgr.client = client
        tele_mgr.me = me
        tele_mgr.ready = True
        tele_mgr.premium = bool(getattr(me, "premium", False))
        tele_mgr.error = None

        print(f"[telethon] Đăng nhập Web thành công: {me.first_name}", flush=True)
        return jsonify(ok=True, name=me.first_name)
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 400


# ================= REST API Routes cho Web Player =================
@app.route("/", methods=["GET"])
def home():
    return jsonify({
        "app": "AmbiMusic Hub Server (2GB MTProto)",
        "version": "1.0.0",
        "login_url": "/login",
        "telethon_ready": tele_mgr.ready,
        "endpoints": ["/login", "/check", "/api/status", "/api/ping", "/api/tracks", "/api/upload", "/api/stream/<id>"]
    })


@app.route("/check", methods=["GET"])
def check():
    total, used, free = shutil.disk_usage(BASE)
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM tracks")
    track_count = cur.fetchone()[0]
    conn.close()
    return jsonify({
        "status": "healthy",
        "app": "AmbiMusic Server",
        "mtproto_2gb": tele_mgr.ready,
        "tracks_in_db": track_count,
        "disk_free_gb": round(free / (1024**3), 2),
    })


@app.route("/api/status", methods=["GET"])
def status():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM tracks")
    track_count = cur.fetchone()[0]
    conn.close()

    acc = ""
    if tele_mgr.ready and tele_mgr.me:
        acc = f"{tele_mgr.me.first_name} (2GB MTProto)"
    elif not tele_mgr.ready:
        acc = "Chưa kết nối (mở /login để bật 2GB)"

    return jsonify({
        "server": "ambimusic",
        "version": "1.0.0",
        "needs_code": False,
        "track_count": track_count,
        "telegram": {
            "ready": tele_mgr.ready,
            "error": tele_mgr.error,
            "premium": tele_mgr.premium,
            "account": acc
        }
    })


@app.route("/api/ping", methods=["GET"])
def ping():
    return jsonify(ok=True)


@app.route("/api/tracks", methods=["GET"])
def list_tracks():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT id, title, artist, album, duration, has_cover, file_size FROM tracks ORDER BY id DESC")
    rows = cur.fetchall()
    conn.close()

    items = [
        {
            "id": r["id"],
            "title": r["title"],
            "artist": r["artist"] or "",
            "album": r["album"] or "",
            "duration": r["duration"] or 0,
            "hasCover": bool(r["has_cover"]),
            "size": r["file_size"] or 0,
            "by": "Telegram 2GB" if tele_mgr.ready else "Bot API"
        }
        for r in rows
    ]
    return jsonify(tracks=items, count=len(items))


# ================= Theo dõi tiến độ Upload lên Telegram =================
_upload_progress = {}
_progress_lock = threading.Lock()


@app.route("/api/upload/progress/<upload_id>", methods=["GET"])
def get_upload_progress(upload_id):
    with _progress_lock:
        prog = _upload_progress.get(upload_id)
    if not prog:
        return jsonify(ok=True, status="idle", percent=0)
    return jsonify(ok=True, **prog)


# ================= Upload File Nhạc (Lên đến 2GB) =================
@app.route("/api/upload", methods=["POST"])
def upload_track():
    print("[upload] Nhận request upload bài hát...", flush=True)
    f = request.files.get("file")
    if not f:
        return jsonify(ok=False, error="Thiếu file nhạc"), 400

    upload_id = request.form.get("upload_id") or f"up_{int(time.time()*1000)}"

    try:
        meta = json.loads(request.form.get("meta") or "{}")
    except Exception:
        meta = {}

    orig = f.filename or "audio.mp3"
    title = meta.get("title") or Path(orig).stem or "Bài hát"
    artist = meta.get("artist") or "Nghệ sĩ chưa rõ"
    album = meta.get("album") or ""
    try:
        duration = float(meta.get("duration") or 0)
    except Exception:
        duration = 0

    # Lưu file vào thư mục tạm trên ổ cứng 20GB của container
    safe_name = re.sub(r'[^\w\.-]', '_', orig)
    temp_path = TMP_DIR / f"{int(time.time())}_{safe_name}"
    f.save(str(temp_path))
    file_size = temp_path.stat().st_size
    total_mb = round(file_size / (1024 * 1024), 1)

    with _progress_lock:
        _upload_progress[upload_id] = {
            "status": "processing",
            "percent": 0,
            "current_mb": 0,
            "total_mb": total_mb,
            "speed_mbps": 0,
            "updated_at": time.time(),
        }

    print(f"[upload] Đã lưu file tạm '{title}' ({total_mb} MB). Bắt đầu gửi lên Telegram...", flush=True)

    tele_msg_id = None
    tele_file_id = None

    # TH1: Sử dụng Telethon MTProto (Hỗ trợ tối đa 2GB)
    if tele_mgr.ready:
        try:
            async def _send_mtproto():
                attrs = [DocumentAttributeAudio(duration=int(duration), title=title, performer=artist)]
                caption = f"🎵 {title} - {artist}\n#ambimusic {json.dumps({'t': title, 'a': artist, 'd': duration}, ensure_ascii=False)}"

                last_time = time.time()
                last_bytes = 0

                def _progress_cb(current, total):
                    nonlocal last_time, last_bytes
                    now = time.time()
                    dt = now - last_time
                    speed = 0
                    if dt >= 0.5:
                        speed = round(((current - last_bytes) / dt) / (1024 * 1024), 1)
                        last_time = now
                        last_bytes = current
                    pct = round((current / total) * 100, 1) if total else 0
                    with _progress_lock:
                        curr_speed = speed if speed > 0 else _upload_progress.get(upload_id, {}).get("speed_mbps", 0)
                        _upload_progress[upload_id] = {
                            "status": "uploading_telegram",
                            "percent": pct,
                            "current_mb": round(current / (1024 * 1024), 1),
                            "total_mb": round(total / (1024 * 1024), 1),
                            "speed_mbps": curr_speed,
                            "updated_at": now,
                        }

                msg = await tele_mgr.client.send_file(
                    "me",
                    str(temp_path),
                    caption=caption,
                    attributes=attrs,
                    progress_callback=_progress_cb
                )
                return msg.id

            tele_msg_id = tele_mgr.run(_send_mtproto(), timeout=900)  # timeout 15 phút cho file lớn
            print(f"[upload] MTProto thành công: message_id={tele_msg_id}", flush=True)
        except Exception as e:
            print(f"[upload] Lỗi Telethon: {e}", flush=True)
            with _progress_lock:
                _upload_progress[upload_id] = {"status": "error", "error": str(e), "percent": 0}
            if temp_path.exists():
                temp_path.unlink()
            return jsonify(ok=False, error=f"Lỗi tải lên Telegram 2GB: {e}"), 502

    # TH2: Dự phòng bằng Bot API (file nhỏ < 50MB khi chưa đăng nhập MTProto)
    else:
        if file_size > 50 * 1024 * 1024:
            if temp_path.exists():
                temp_path.unlink()
            return jsonify(ok=False, error="File > 50MB. Vui lòng mở /login trên trình duyệt để đăng nhập Telegram bật hạn mức 2GB!"), 400

        try:
            file_bytes = temp_path.read_bytes()
            boundary = "----WebKitFormBoundaryAmbiMusic" + str(int(time.time()))
            body = bytearray()
            body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n{DEFAULT_CHAT_ID}\r\n".encode())
            body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\n{title[:100]}\r\n".encode())
            body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"performer\"\r\n\r\n{artist[:100]}\r\n".encode())
            body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"{safe_name}\"\r\nContent-Type: audio/mpeg\r\n\r\n".encode())
            body.extend(file_bytes)
            body.extend(f"\r\n--{boundary}--\r\n".encode())

            req = urllib.request.Request(
                f"https://api.telegram.org/bot{DEFAULT_BOT_TOKEN}/sendAudio",
                data=bytes(body),
                headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}
            )
            with urllib.request.urlopen(req, timeout=180) as resp:
                res = json.loads(resp.read().decode())
                if res.get("ok"):
                    aud = res["result"].get("audio") or res["result"].get("document", {})
                    tele_file_id = aud.get("file_id")
                    tele_msg_id = res["result"]["message_id"]
        except Exception as e:
            if temp_path.exists():
                temp_path.unlink()
            return jsonify(ok=False, error=f"Bot API upload error: {e}"), 502

    # Dọn dẹp file tạm trên ổ cứng sau khi đã gửi lên Telegram thành công
    if temp_path.exists():
        temp_path.unlink()

    # Xử lý ảnh bìa nếu có
    has_cover = 0
    cover_file = request.files.get("cover")
    cover_bytes = cover_file.read() if cover_file else None

    # Lưu vào SQLite
    now = int(time.time() * 1000)
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO tracks (title, artist, album, duration, has_cover, file_id, file_size, message_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (title, artist, album, duration, 1 if cover_bytes else 0, tele_file_id, file_size, tele_msg_id, now)
    )
    new_id = cur.lastrowid
    conn.commit()
    conn.close()

    if cover_bytes:
        has_cover = 1
        (COVER_DIR / f"{new_id}.jpg").write_bytes(cover_bytes)

    with _progress_lock:
        _upload_progress[upload_id] = {
            "status": "done",
            "percent": 100,
            "current_mb": total_mb,
            "total_mb": total_mb,
            "speed_mbps": 0,
            "updated_at": time.time(),
        }
        # Dọn dẹp tiến trình cũ quá 10 phút
        now_t = time.time()
        for k in [k for k, v in _upload_progress.items() if now_t - v.get("updated_at", 0) > 600]:
            _upload_progress.pop(k, None)

    print(f"[upload] Hoàn tất bài hát id={new_id}: '{title}'", flush=True)
    return jsonify(
        ok=True,
        track={
            "id": new_id,
            "title": title,
            "artist": artist,
            "album": album,
            "duration": duration,
            "hasCover": bool(has_cover),
            "size": file_size,
            "by": "Telegram"
        }
    )


# ================= Stream Audio (Hỗ trợ Range Request tới 2GB) =================
@app.route("/api/stream/<int:tid>", methods=["GET"])
def stream_audio(tid):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT file_id, file_size, message_id FROM tracks WHERE id = ?", (tid,))
    row = cur.fetchone()
    conn.close()

    if not row:
        return jsonify(ok=False, error="Không tìm thấy bài hát"), 404

    # TH1: Stream qua Telethon MTProto (Tua được, file tới 2GB)
    if tele_mgr.ready and row["message_id"]:
        try:
            async def _get_doc():
                msg = await tele_mgr.client.get_messages("me", ids=row["message_id"])
                return msg.document

            doc = tele_mgr.run(_get_doc())
            if not doc:
                return jsonify(ok=False, error="Không tìm thấy file trên Telegram"), 404

            size = doc.size
            range_header = request.headers.get("Range")
            start = 0
            end = size - 1

            if range_header:
                m = re.match(r"bytes=(\d+)-(\d*)", range_header)
                if m:
                    s_str, e_str = m.groups()
                    start = int(s_str)
                    if e_str:
                        end = min(int(e_str), size - 1)

            length = (end - start + 1)
            chunk_size = 512 * 1024

            def iter_chunks():
                loop = tele_mgr.loop
                async def _read():
                    async for chunk in tele_mgr.client.iter_download(doc, offset=start, limit=length, request_size=chunk_size):
                        yield chunk
                # Bridge async generator to sync generator
                q = asyncio.Queue()
                # Run reader
                async def _worker():
                    async for c in tele_mgr.client.iter_download(doc, offset=start, limit=length, request_size=chunk_size):
                        await q.put(c)
                    await q.put(None)

                asyncio.run_coroutine_threadsafe(_worker(), loop)
                while True:
                    future = asyncio.run_coroutine_threadsafe(q.get(), loop)
                    data = future.result()
                    if data is None:
                        break
                    yield data

            headers = {
                "Content-Type": getattr(doc, "mime_type", "audio/mpeg"),
                "Accept-Ranges": "bytes",
                "Content-Length": str(length),
                "Content-Range": f"bytes {start}-{end}/{size}"
            }
            return Response(iter_chunks(), status=206 if range_header else 200, headers=headers)
        except Exception as e:
            print(f"[stream] Lỗi MTProto stream: {e}", flush=True)

    # TH2: Stream qua Bot API (Dự phòng cho file nhỏ)
    if row["file_id"]:
        api_url = f"https://api.telegram.org/bot{DEFAULT_BOT_TOKEN}/getFile?file_id={urllib.parse.quote(row['file_id'])}"
        with urllib.request.urlopen(api_url, timeout=10) as resp:
            res = json.loads(resp.read().decode())
            if res.get("ok"):
                direct_url = f"https://api.telegram.org/file/bot{DEFAULT_BOT_TOKEN}/{res['result']['file_path']}"
                req_headers = {"User-Agent": "AmbiMusic/1.0"}
                if request.headers.get("Range"):
                    req_headers["Range"] = request.headers.get("Range")
                upstream = urllib.request.urlopen(urllib.request.Request(direct_url, headers=req_headers), timeout=20)
                headers = {}
                for h in ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"]:
                    if upstream.headers.get(h):
                        headers[h] = upstream.headers.get(h)
                headers.setdefault("Accept-Ranges", "bytes")
                return Response(upstream.read(), status=upstream.getcode() or 200, headers=headers)

    return jsonify(ok=False, error="Không thể stream bài hát"), 404


@app.route("/api/cover/<int:tid>", methods=["GET"])
def get_cover(tid):
    cover_path = COVER_DIR / f"{tid}.jpg"
    if cover_path.exists():
        return Response(cover_path.read_bytes(), mimetype="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})
    return jsonify(error="No cover"), 404


@app.route("/api/tracks/<int:tid>", methods=["DELETE"])
def delete_track(tid):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT message_id FROM tracks WHERE id = ?", (tid,))
    row = cur.fetchone()

    # Xóa trên Telegram nếu có phiên Telethon
    if row and row["message_id"] and tele_mgr.ready:
        try:
            tele_mgr.run(tele_mgr.client.delete_messages("me", ids=[row["message_id"]]))
        except Exception as e:
            print(f"[delete] Lỗi xóa tin nhắn: {e}", flush=True)

    cur.execute("DELETE FROM tracks WHERE id = ?", (tid,))
    deleted = cur.rowcount
    conn.commit()
    conn.close()

    cover_path = COVER_DIR / f"{tid}.jpg"
    if cover_path.exists():
        cover_path.unlink()

    return jsonify(ok=True, deleted=deleted)


if __name__ == "__main__":
    print("=" * 60, flush=True)
    print(f"🎵 AmbiMusic Hub Server (2GB MTProto) chạy trên cổng {PORT}", flush=True)
    print(f"👉 Mở link Web Đăng Nhập Telegram: http://0.0.0.0:{PORT}/login", flush=True)
    print("=" * 60, flush=True)
    app.run(host="0.0.0.0", port=PORT, threaded=True)