/**
 * AmbiMusic - High Performance Ambient Audio Player
 * 100% Free • Persistent Offline IndexedDB • Dynamic Ambient Glow
 */

// ================= IndexedDB Manager =================
class MusicDB {
  constructor() {
    this.dbName = 'AmbiMusicDB';
    this.version = 1;
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('tracks')) {
          db.createObjectStore('tracks', { keyPath: 'id' });
        }
      };
      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };
      request.onerror = (e) => reject(e);
    });
  }

  async saveTrack(track) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('tracks', 'readwrite');
      const store = tx.objectStore('tracks');
      store.put(track);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e);
    });
  }

  async saveTracksBatch(tracks) {
    if (!tracks || tracks.length === 0) return;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('tracks', 'readwrite');
      const store = tx.objectStore('tracks');
      for (const track of tracks) {
        store.put(track);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e);
    });
  }

  async getAllTracks() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('tracks', 'readonly');
      const store = tx.objectStore('tracks');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = (e) => reject(e);
    });
  }

  async deleteTrack(id) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('tracks', 'readwrite');
      const store = tx.objectStore('tracks');
      store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e);
    });
  }

  async clearAll() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('tracks', 'readwrite');
      const store = tx.objectStore('tracks');
      store.clear();
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e);
    });
  }
}

// ================= Pure JS ID3 Tag Parser =================
async function extractMetadata(file) {
  const defaultTitle = file && file.name ? file.name.replace(/\.[^/.]+$/, '') : 'Bài hát';
  const result = {
    title: defaultTitle,
    artist: 'Nghệ sĩ chưa rõ',
    album: '',
    coverUrl: null,
    duration: 0
  };

  try {
    const buffer = await file.slice(0, 4000000).arrayBuffer();
    const view = new DataView(buffer);

    // Check ID3v2 tag identifier
    if (view.getUint8(0) === 0x49 && view.getUint8(1) === 0x44 && view.getUint8(2) === 0x33) {
      let offset = 10;
      const tagSize = ((view.getUint8(6) & 0x7F) << 21) |
        ((view.getUint8(7) & 0x7F) << 14) |
        ((view.getUint8(8) & 0x7F) << 7) |
        (view.getUint8(9) & 0x7F);

      while (offset < tagSize + 10 && offset < buffer.byteLength - 10) {
        let frameID = '';
        for (let i = 0; i < 4; i++) {
          frameID += String.fromCharCode(view.getUint8(offset + i));
        }

        const b = [4, 5, 6, 7].map(k => view.getUint8(offset + k));
        const frameSize = view.getUint8(3) >= 4
          ? ((b[0] & 0x7F) << 21) | ((b[1] & 0x7F) << 14) | ((b[2] & 0x7F) << 7) | (b[3] & 0x7F)
          : (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3];

        if (!frameID.match(/^[A-Z0-9]{4}$/) || frameSize <= 0 || frameSize > tagSize) {
          break;
        }
        if (offset + 10 + frameSize > buffer.byteLength) break;

        const frameOffset = offset + 10;

        // Title (TIT2)
        if (frameID === 'TIT2') {
          result.title = decodeFrameText(view, frameOffset, frameSize) || result.title;
        }
        // Artist (TPE1)
        else if (frameID === 'TPE1') {
          result.artist = decodeFrameText(view, frameOffset, frameSize) || result.artist;
        }
        // Album (TALB)
        else if (frameID === 'TALB') {
          result.album = decodeFrameText(view, frameOffset, frameSize) || '';
        }
        // Album Art (APIC)
        else if (frameID === 'APIC') {
          try {
            const picBlob = extractApicPicture(view, frameOffset, frameSize);
            if (picBlob) {
              result.coverUrl = await blobToDataUrl(picBlob);
            }
          } catch (e) {
            console.warn('Cover art parse error:', e);
          }
        }

        offset += 10 + frameSize;
      }
    }
  } catch (err) {
    console.warn('Error reading ID3 tags:', err);
  }

  // Fallback: If title has "Artist - Song Name"
  if (result.title.includes(' - ')) {
    const parts = result.title.split(' - ');
    result.artist = parts[0].trim();
    result.title = parts.slice(1).join(' - ').trim();
  }

  return result;
}

function decodeFrameText(view, offset, size) {
  const encoding = view.getUint8(offset);
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset + 1, size - 1);
  try {
    if (encoding === 1 || encoding === 2) {
      return new TextDecoder(encoding === 2 ? 'utf-16be' : 'utf-16').decode(bytes).replace(/\0/g, '').trim();
    } else {
      return new TextDecoder('utf-8').decode(bytes).replace(/\0/g, '').trim();
    }
  } catch (e) {
    return '';
  }
}

function extractApicPicture(view, offset, size) {
  const encoding = view.getUint8(offset);
  let p = offset + 1; // skip encoding

  // read MIME type until null
  let mime = '';
  while (p < offset + size && view.getUint8(p) !== 0) {
    mime += String.fromCharCode(view.getUint8(p));
    p++;
  }
  p++; // skip MIME null terminator
  if (p >= offset + size) return null;

  p++; // skip picture type (1 byte)

  // skip description based on text encoding
  if (encoding === 1 || encoding === 2) {
    // UTF-16 terminated by double null (\0\0)
    while (p < offset + size - 1 && !(view.getUint8(p) === 0 && view.getUint8(p + 1) === 0)) {
      p += 2;
    }
    p += 2; // skip double null
  } else {
    // ISO-8859-1 or UTF-8 terminated by single null (\0)
    while (p < offset + size && view.getUint8(p) !== 0) {
      p++;
    }
    p++; // skip single null
  }

  if (p < offset + size) {
    const imgData = new Uint8Array(view.buffer, view.byteOffset + p, (offset + size) - p);
    return new Blob([imgData], { type: mime || 'image/jpeg' });
  }
  return null;
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

// ================= Cloud: AmbiMusic Server =================
// App nói chuyện với AmbiMusic Server (Python). Server giữ tài khoản Telegram, lưu nhạc lên Telegram
// và cho cả nhóm dùng chung một kho nhạc. Trình duyệt không còn giữ Bot Token nào.
const MIXED_MSG = 'Trang https không gọi được server http. Hãy để trống ô "Địa chỉ server" (dùng đường /api qua Vercel) ' +
  'hoặc mở app trực tiếp từ địa chỉ của server.';

// Thu nhỏ ảnh bìa thành ảnh vuông JPEG (dùng làm ảnh bìa gửi kèm lên cloud)
function makeThumb(dataUrl, size = 320) {
  return new Promise((resolve) => {
    if (!dataUrl) return resolve(null);
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
        c.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, size, size);
        resolve(c.toDataURL('image/jpeg', 0.8));
      } catch (e) { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const mime = (head.match(/:(.*?);/) || [])[1] || 'image/jpeg';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
  });
}

const DEFAULT_SERVER = 'http://arc.pikamc.vn:25635';
const DEFAULT_KEY = 'nhac123';

class CloudClient {
  constructor() {
    const isHttps = location.protocol === 'https:';
    // Khi chạy trên HTTPS (như Vercel), mặc định để server rỗng để qua proxy /api của Vercel chống lỗi Mixed Content
    const fallbackServer = isHttps ? '' : DEFAULT_SERVER;
    const storedServer = localStorage.getItem('ambi_server');
    this.server = (storedServer !== null ? storedServer : fallbackServer).trim().replace(/\/+$/, '');
    this.key = (localStorage.getItem('ambi_key') || DEFAULT_KEY).trim();
    this.autoSync = localStorage.getItem('ambi_auto') === null ? true : localStorage.getItem('ambi_auto') === '1';
  }

  get enabled() { return !!this.key; }
  get serverLabel() { return this.server ? this.server.replace(/^https?:\/\//i, '') : 'cùng máy chủ (/api)'; }

  setConfig(server, key, auto = false) {
    let s = (server || '').trim().replace(/\/+$/, '');
    if (s && !/^https?:\/\//i.test(s)) s = 'http://' + s;
    this.server = s;
    this.key = (key || '').trim();
    this.autoSync = !!auto;
    localStorage.setItem('ambi_server', this.server);
    localStorage.setItem('ambi_key', this.key);
    localStorage.setItem('ambi_auto', this.autoSync ? '1' : '0');
  }

  url(path) {
    let s = (this.server || '').trim().replace(/\/+$/, '');
    if (!s) return path;
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    return s + path;
  }
  mixedContent() { return location.protocol === 'https:' && /^http:\/\//i.test(this.server); }
  streamUrl(id) { return this.url(`/api/stream/${id}?k=${encodeURIComponent(this.key)}`); }

  _failure(status, data) {
    const reason = status === 401 ? 'auth' : status === 429 ? 'throttle' : status === 413 ? 'too_large' : 'api';
    let description = data && data.error;
    if (!description) {
      description = `HTTP ${status}: phản hồi không phải của AmbiMusic Server` +
        (this.server ? '' : ' (kiểm tra vercel.json và server đã chạy chưa)');
    }
    return { ok: false, reason, status, description };
  }

  async request(path, { method = 'GET', auth = true } = {}) {
    if (this.mixedContent()) return { ok: false, reason: 'mixed', description: MIXED_MSG };
    let res;
    try {
      res = await fetch(this.url(path), { method, headers: auth ? { 'X-Ambi-Key': this.key } : {} });
    } catch (e) {
      return { ok: false, reason: 'network', description: 'Không kết nối được tới server (server đang tắt, sai địa chỉ hoặc mất mạng).' };
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* không phải JSON */ }
    if (res.ok) return { ok: true, data };
    return this._failure(res.status, data);
  }

  status() { return this.request('/api/status', { auth: false }); }
  ping() { return this.request('/api/ping'); }
  list(refresh = false) { return this.request('/api/tracks' + (refresh ? '?refresh=1' : '')); }
  remove(id) { return this.request(`/api/tracks/${id}`, { method: 'DELETE' }); }

  async cover(id) {
    try {
      const res = await fetch(this.url(`/api/cover/${id}`), { headers: { 'X-Ambi-Key': this.key } });
      return res.ok ? await res.blob() : null;
    } catch (e) { return null; }
  }

  // Gửi file lên server (server đẩy tiếp lên Telegram). onProgress({ phase, percent, ... })
  async upload(track, onProgress) {
    if (this.mixedContent()) return { ok: false, reason: 'mixed', description: MIXED_MSG };
    const blob = track.fileBlob;
    const form = new FormData();
    const uploadId = 'up_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    form.append('upload_id', uploadId);
    form.append('meta', JSON.stringify({
      title: track.title, artist: track.artist, album: track.album || '', duration: Math.round(track.duration || 0)
    }));
    if (track.coverUrl) {
      const thumb = await makeThumb(track.coverUrl, 320);
      if (thumb) form.append('cover', dataUrlToBlob(thumb), 'cover.jpg');
    }
    const fallbackName = /wav/i.test(blob.type) ? 'audio.wav' : /flac/i.test(blob.type) ? 'audio.flac' : 'audio.mp3';
    form.append('file', blob, blob.name || fallbackName); // file đặt cuối cùng

    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', this.url('/api/upload'));
      xhr.setRequestHeader('X-Ambi-Key', this.key);

      let pollTimer = null;
      const stopPolling = () => {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      };

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          const pct = Math.round((e.loaded / e.total) * 100);
          onProgress({
            phase: 'server',
            percent: pct,
            loaded: e.loaded,
            total: e.total
          });
          // Khi đã tải xong lên server (100%), bắt đầu thăm dò tiến độ server gửi sang Telegram
          if (pct >= 100 && !pollTimer) {
            pollTimer = setInterval(async () => {
              try {
                const pRes = await fetch(this.url(`/api/upload/progress/${uploadId}`), {
                  headers: { 'X-Ambi-Key': this.key }
                });
                if (pRes.ok) {
                  const pData = await pRes.json();
                  if (pData && pData.status === 'uploading_telegram' && onProgress) {
                    onProgress({
                      phase: 'telegram',
                      percent: pData.percent,
                      currentMb: pData.current_mb,
                      totalMb: pData.total_mb,
                      speedMbps: pData.speed_mbps
                    });
                  }
                }
              } catch (err) {}
            }, 800);
          }
        }
      };

      xhr.onload = () => {
        stopPolling();
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) { /* không phải JSON */ }
        if (xhr.status >= 200 && xhr.status < 300 && data && data.track) resolve({ ok: true, track: data.track });
        else resolve(this._failure(xhr.status, data));
      };
      xhr.onerror = () => {
        stopPolling();
        resolve({ ok: false, reason: 'network', description: 'Mất kết nối tới server khi đang gửi file.' });
      };
      xhr.send(form);
    });
  }
}

// Generate color palette based on string hash or image

function stringToColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const c1 = `hsl(${Math.abs(hash) % 360}, 80%, 60%)`;
  const c2 = `hsl(${(Math.abs(hash) + 60) % 360}, 90%, 55%)`;
  return [c1, c2];
}

// Extract dominant color from image
function extractColorsFromImage(imgElement) {
  return new Promise((resolve) => {
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = 16;
      canvas.height = 16;
      ctx.drawImage(imgElement, 0, 0, 16, 16);
      const data = ctx.getImageData(0, 0, 16, 16).data;

      let r1 = 0, g1 = 0, b1 = 0, count = 0;
      for (let i = 0; i < data.length; i += 16) {
        r1 += data[i];
        g1 += data[i + 1];
        b1 += data[i + 2];
        count++;
      }
      r1 = Math.round(r1 / count);
      g1 = Math.round(g1 / count);
      b1 = Math.round(b1 / count);

      const color1 = `rgb(${r1}, ${g1}, ${b1})`;
      const color2 = `rgb(${Math.min(255, r1 + 50)}, ${Math.max(0, g1 - 30)}, ${Math.min(255, b1 + 70)})`;
      resolve([color1, color2]);
    } catch (e) {
      resolve(['#6366f1', '#ec4899']);
    }
  });
}

// ================= Player Controller =================
class PlayerController {
  constructor() {
    this.db = new MusicDB();
    this.teleCloud = new CloudClient();
    this.tracks = [];
    this.currentTrackIndex = -1;
    this.selectToken = 0;
    this.currentObjectUrl = null;
    this.isPlaying = false;
    this.isShuffle = false;
    this.loopMode = 0; // 0: None, 1: Loop All, 2: Loop One
    this.ambientIntensityLevel = 2; // 0: Off, 1: Soft, 2: High, 3: Full Max
    this.isSeeking = false;

    // Audio Element & Web Audio API
    this.audio = document.getElementById('audioElement');
    this.audioCtx = null;
    this.analyser = null;
    this.sourceNode = null;

    // DOM Elements
    this.coverWrapper = document.getElementById('coverWrapper');
    this.coverImg = document.getElementById('coverImg');
    this.coverPlaceholder = document.getElementById('coverPlaceholder');
    this.songTitle = document.getElementById('songTitle');
    this.songArtist = document.getElementById('songArtist');
    this.currentTimeEl = document.getElementById('currentTime');
    this.totalDurationEl = document.getElementById('totalDuration');
    this.progressBarContainer = document.getElementById('progressBarContainer');
    this.progressBarFill = document.getElementById('progressBarFill');
    this.progressBarThumb = document.getElementById('progressBarThumb');
    this.playBtn = document.getElementById('playBtn');
    this.playIcon = document.getElementById('playIcon');
    this.prevBtn = document.getElementById('prevBtn');
    this.nextBtn = document.getElementById('nextBtn');
    this.shuffleBtn = document.getElementById('shuffleBtn');
    this.loopBtn = document.getElementById('loopBtn');
    this.volumeSlider = document.getElementById('volumeSlider');
    this.volBtn = document.getElementById('volBtn');
    this.volIcon = document.getElementById('volIcon');
    this.songList = document.getElementById('songList');
    this.emptyState = document.getElementById('emptyState');
    this.trackCountBadge = document.getElementById('trackCountBadge');
    this.fileUploadInput = document.getElementById('fileUploadInput');
    this.dropZone = document.getElementById('dropZone');
    this.searchInput = document.getElementById('searchInput');
    this.clearAllBtn = document.getElementById('clearAllBtn');
    this.emptyUploadBtn = document.getElementById('emptyUploadBtn');
    this.ambientToggleBtn = document.getElementById('ambientToggleBtn');
    this.ambientStatus = document.getElementById('ambientStatus');

    // Theme Switcher Elements
    this.themeDropdown = document.getElementById('themeDropdown');
    this.themeSwitchBtn = document.getElementById('themeSwitchBtn');
    this.themeMenu = document.getElementById('themeMenu');
    this.currentThemeDot = document.getElementById('currentThemeDot');

    // Telegram Elements
    this.telegramSyncBtn = document.getElementById('telegramSyncBtn');
    this.telegramModal = document.getElementById('telegramModal');
    this.closeTeleModal = document.getElementById('closeTeleModal');
    this.teleTokenInput = document.getElementById('teleTokenInput');
    this.teleChatInput = document.getElementById('teleChatInput');
    this.saveTeleConfigBtn = document.getElementById('saveTeleConfigBtn');
    this.pullTeleTracksBtn = document.getElementById('pullTeleTracksBtn');
    this.teleBanner = document.getElementById('teleBanner');
    this.teleBannerText = document.getElementById('teleBannerText');

    // Background Queue State for Lightning-Fast Upload
    this.uploadQueue = [];
    this.isUploadingQueue = false;
    this.totalQueueItems = 0;
    this.completedQueueItems = 0;
    this._toastTimer = null;
    this.metaReady = new Map(); // trackId -> {p, done}: chờ đọc xong ID3 trước khi gửi Telegram

    this.init();
  }

  initTheme() {
    const savedTheme = localStorage.getItem('ambi_theme') || 'neon';
    this.applyTheme(savedTheme);

    if (this.themeSwitchBtn && this.themeMenu) {
      this.themeSwitchBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.themeMenu.classList.toggle('show');
      });

      document.addEventListener('click', (e) => {
        if (this.themeDropdown && !this.themeDropdown.contains(e.target)) {
          this.themeMenu.classList.remove('show');
        }
      });

      this.themeMenu.querySelectorAll('.theme-btn-option').forEach(btn => {
        btn.addEventListener('click', () => {
          const theme = btn.dataset.theme;
          this.applyTheme(theme);
          this.themeMenu.classList.remove('show');
          const title = btn.querySelector('.theme-btn-title');
          this.showToast(`✨ Đã đổi giao diện: ${title ? title.textContent : theme}`);
        });
      });
    }
  }

  applyTheme(themeName) {
    document.body.setAttribute('data-theme', themeName);
    localStorage.setItem('ambi_theme', themeName);

    if (this.themeMenu) {
      this.themeMenu.querySelectorAll('.theme-btn-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === themeName);
      });
    }

    const themeColors = {
      'neon': '#6366f1',
      'obsidian': '#f59e0b',
      'aurora': '#10b981',
      'cyberpunk': '#00f0ff',
      'sunset': '#ff7e5f',
      'minimal-light': '#ffffff'
    };
    if (this.currentThemeDot) {
      const col = themeColors[themeName] || '#6366f1';
      this.currentThemeDot.style.background = col;
      this.currentThemeDot.style.boxShadow = `0 0 8px ${col}`;
    }
  }

  showToast(message, duration = 3500) {
    let toast = document.getElementById('ambiToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'ambiToast';
      toast.className = 'ambi-toast';
      document.body.appendChild(toast);
    }
    toast.innerHTML = message;
    toast.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      toast.classList.remove('show');
    }, duration);
  }

  updateTeleStatus() {
    const ok = this.teleCloud.enabled;
    const dot = document.getElementById('teleDot');
    dot.style.background = ok ? '#10b981' : '#64748b';
    dot.style.boxShadow = ok ? '0 0 8px #10b981' : 'none';
    document.getElementById('teleBadge').textContent = ok ? 'Đã cấu hình' : 'Chưa cấu hình';
    document.getElementById('displayChatId').textContent = this.teleCloud.serverLabel;
  }

  saveSettings() {
    try {
      localStorage.setItem('ambi_settings', JSON.stringify({
        volume: this.audio.volume, shuffle: this.isShuffle,
        loop: this.loopMode, ambient: this.ambientIntensityLevel
      }));
    } catch (e) { /* storage đầy hoặc bị chặn */ }
  }

  loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem('ambi_settings')) || {}; } catch (e) { }
    if (typeof s.volume === 'number') {
      this.audio.volume = s.volume;
      this.volumeSlider.value = s.volume;
      this.updateVolumeIcon();
    }
    this.isShuffle = !!s.shuffle;
    this.shuffleBtn.classList.toggle('active', this.isShuffle);
    // Dùng lại handler có sẵn: lùi 1 mức rồi "bấm" để áp dụng đúng UI
    if (Number.isInteger(s.loop) && s.loop > 0) {
      this.loopMode = (s.loop + 2) % 3;
      this.loopBtn.click();
    }
    if (Number.isInteger(s.ambient) && s.ambient !== this.ambientIntensityLevel) {
      this.ambientIntensityLevel = (s.ambient + 3) % 4;
      this.ambientToggleBtn.click();
    }
  }

  async init() {
    this.initTheme();
    await this.db.init();
    await this.loadStoredTracks();
    this.setupEventListeners();
    this.setupVisualizer();
    this.updateTeleStatus();
    // Tự động kết nối và kéo kho nhạc từ server Pikamc
    if (this.teleCloud.enabled) {
      this.pullLibrary().catch(() => {});
    }
  }

  async loadStoredTracks() {
    const stored = await this.db.getAllTracks();
    // Dọn dữ liệu của bản cũ (Bot API): bài chỉ có file_id không phát được với server mới
    for (const t of stored) {
      if (t.fileId !== undefined || t.messageId !== undefined) {
        if (t.fileBlob) { delete t.fileId; delete t.messageId; t.cloudId = null; await this.db.saveTrack(t); }
        else await this.db.deleteTrack(t.id);
      }
    }
    this.tracks = stored.filter(t => t.fileBlob || t.cloudId);
    this.renderPlaylist();
    if (this.tracks.length > 0) {
      this.selectTrack(0, false);
    }
  }

  setupEventListeners() {
    // Play / Pause
    this.playBtn.addEventListener('click', () => this.togglePlay());
    this.prevBtn.addEventListener('click', () => this.playPrev());
    this.nextBtn.addEventListener('click', () => this.playNext());

    // Shuffle & Loop
    this.shuffleBtn.addEventListener('click', () => {
      this.isShuffle = !this.isShuffle;
      this.shuffleBtn.classList.toggle('active', this.isShuffle);
    });

    this.loopBtn.addEventListener('click', () => {
      this.loopMode = (this.loopMode + 1) % 3;
      if (this.loopMode === 0) {
        this.loopBtn.classList.remove('active');
        this.loopBtn.title = 'Lặp lại: TẮT';
      } else if (this.loopMode === 1) {
        this.loopBtn.classList.add('active');
        this.loopBtn.title = 'Lặp lại: Toàn bộ danh sách';
      } else {
        this.loopBtn.classList.add('active');
        this.loopBtn.title = 'Lặp lại: 1 bài';
      }
    });

    // Audio events
    this.audio.addEventListener('timeupdate', () => this.updateProgress());
    this.audio.addEventListener('loadedmetadata', () => {
      this.totalDurationEl.textContent = this.formatTime(this.audio.duration);
      const cur = this.tracks[this.currentTrackIndex];
      if (cur && !cur.duration && isFinite(this.audio.duration)) cur.duration = Math.round(this.audio.duration);
    });
    this.audio.addEventListener('ended', () => this.handleSongEnd());
    this.audio.addEventListener('error', () => {
      const t = this.tracks[this.currentTrackIndex];
      if (!t || t.fileBlob || !t.cloudId) return;
      this.showToast(this.teleCloud.mixedContent() ? '⚠️ ' + MIXED_MSG
        : '⚠️ Không phát được từ cloud (server tắt, sai mã nhóm hoặc bài đã bị xóa). Thử bấm Đồng bộ.', 7000);
    });
    this.audio.addEventListener('play', () => { this.isPlaying = true; this.updatePlayState(); });
    this.audio.addEventListener('pause', () => { this.isPlaying = false; this.updatePlayState(); });

    // Progress bar seeking
    const seek = (e) => {
      const rect = this.progressBarContainer.getBoundingClientRect();
      const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      this.progressBarFill.style.width = `${pos * 100}%`;
      this.progressBarThumb.style.left = `${pos * 100}%`;
      if (!this.audio.duration) return;
      this.currentTimeEl.textContent = this.formatTime(pos * this.audio.duration);
      this.audio.currentTime = pos * this.audio.duration;
    };
    this.progressBarContainer.addEventListener('pointerdown', (e) => {
      this.isSeeking = true;
      this.progressBarContainer.setPointerCapture(e.pointerId);
      seek(e);
    });
    this.progressBarContainer.addEventListener('pointermove', (e) => {
      if (this.isSeeking) seek(e);
    });
    ['pointerup', 'pointercancel'].forEach(ev =>
      this.progressBarContainer.addEventListener(ev, () => { this.isSeeking = false; }));

    // Volume
    this.volumeSlider.addEventListener('input', (e) => {
      this.audio.volume = parseFloat(e.target.value);
      this.updateVolumeIcon();
    });

    this.volBtn.addEventListener('click', () => {
      if (this.audio.volume > 0) {
        this.prevVolume = this.audio.volume;
        this.audio.volume = 0;
        this.volumeSlider.value = 0;
      } else {
        this.audio.volume = this.prevVolume || 0.8;
        this.volumeSlider.value = this.audio.volume;
      }
      this.updateVolumeIcon();
    });

    // Upload & Drag Drop
    this.fileUploadInput.addEventListener('change', (e) => this.handleFileUpload(e.target.files));
    this.emptyUploadBtn.addEventListener('click', () => this.fileUploadInput.click());

    // Drag and drop zone
    ['dragenter', 'dragover'].forEach(eventName => {
      this.dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        this.dropZone.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(eventName => {
      this.dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        this.dropZone.classList.remove('dragover');
      });
    });
    this.dropZone.addEventListener('drop', async (e) => {
      e.preventDefault();
      this.dropZone.classList.remove('dragover');
      if (e.dataTransfer) {
        const files = await this.extractFilesFromDataTransfer(e.dataTransfer);
        if (files && files.length > 0) {
          this.handleFileUpload(files);
        }
      }
    });
    this.dropZone.addEventListener('click', () => this.fileUploadInput.click());

    // Clear All
    this.clearAllBtn.addEventListener('click', async () => {
      if (confirm('Sếp có chắc chắn muốn xóa toàn bộ danh sách nhạc không?')) {
        await this.db.clearAll();
        this.tracks = [];
        this.currentTrackIndex = -1;
        this.audio.pause();
        this.audio.src = '';
        this.isPlaying = false;
        this.updatePlayState();
        this.renderPlaylist();
      }
    });

    // Search filter
    this.searchInput.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      const items = this.songList.querySelectorAll('.song-item');
      items.forEach(item => {
        const title = item.querySelector('.song-item-title').textContent.toLowerCase();
        const artist = item.querySelector('.song-item-artist').textContent.toLowerCase();
        if (title.includes(q) || artist.includes(q)) {
          item.style.display = 'flex';
        } else {
          item.style.display = 'none';
        }
      });
    });

    // Ambient light intensity toggle
    this.ambientToggleBtn.addEventListener('click', () => {
      this.ambientIntensityLevel = (this.ambientIntensityLevel + 1) % 4;
      const root = document.documentElement;
      if (this.ambientIntensityLevel === 0) {
        root.style.setProperty('--ambient-intensity', '0');
        this.ambientStatus.textContent = 'TẮT';
      } else if (this.ambientIntensityLevel === 1) {
        root.style.setProperty('--ambient-intensity', '0.35');
        root.style.setProperty('--ambient-blur', '70px');
        this.ambientStatus.textContent = 'ÊM DỊU';
      } else if (this.ambientIntensityLevel === 2) {
        root.style.setProperty('--ambient-intensity', '0.65');
        root.style.setProperty('--ambient-blur', '100px');
        this.ambientStatus.textContent = 'RỰC RỠ';
      } else {
        root.style.setProperty('--ambient-intensity', '1.0');
        root.style.setProperty('--ambient-blur', '140px');
        this.ambientStatus.textContent = 'CỰC ĐẠI 🔥';
      }
    });

    // Telegram Modal & Sync Events
    this.telegramSyncBtn.addEventListener('click', () => {
      this.teleTokenInput.value = this.teleCloud.server || DEFAULT_SERVER;
      this.teleChatInput.value = this.teleCloud.key || DEFAULT_KEY;
      document.getElementById('teleAutoSync').checked = this.teleCloud.autoSync;
      this.updateTeleStatus();
      this.telegramModal.style.display = 'flex';
    });

    this.closeTeleModal.addEventListener('click', () => {
      this.telegramModal.style.display = 'none';
    });

    this.telegramModal.addEventListener('click', (e) => {
      if (e.target === this.telegramModal) {
        this.telegramModal.style.display = 'none';
      }
    });

    this.saveTeleConfigBtn.addEventListener('click', () => {
      this.teleCloud.setConfig(this.teleTokenInput.value, this.teleChatInput.value,
        document.getElementById('teleAutoSync').checked);
      this.updateTeleStatus();
      this.renderPlaylist();
      alert('Đã lưu cấu hình!');
      this.telegramModal.style.display = 'none';
    });

    // Kiểm tra server bằng giá trị đang nhập trong form (chưa cần bấm Lưu)
    const checkBtn = document.getElementById('checkServerBtn');
    if (checkBtn) {
      checkBtn.addEventListener('click', async () => {
        const probe = new CloudClient();
        let s = this.teleTokenInput.value.trim().replace(/\/+$/, '');
        if (s && !/^https?:\/\//i.test(s)) s = 'http://' + s;
        probe.server = s;
        probe.key = this.teleChatInput.value.trim();
        checkBtn.disabled = true;
        checkBtn.textContent = 'Đang kiểm tra...';
        const st = await probe.status();
        let msg;
        if (!st.ok) {
          msg = '❌ ' + st.description;
        } else {
          const tg = st.data.telegram || {};
          const auth = probe.key ? await probe.ping() : { ok: false, description: 'Chưa nhập mã nhóm' };
          msg = `✅ Server AmbiMusic v${st.data.version} đang chạy.\n` +
            (tg.ready ? `✅ Telegram: sẵn sàng${tg.premium ? ' (Premium)' : ''}.\n` : `⚠️ Telegram chưa sẵn sàng: ${tg.error || 'không rõ lỗi'}\n`) +
            (auth.ok ? '✅ Mã nhóm đúng.' : `❌ Mã nhóm: ${auth.description}`);
        }
        alert(msg);
        checkBtn.disabled = false;
        checkBtn.textContent = '🩺 Kiểm tra server';
      });
    }

    this.pushAllToTeleBtn = document.getElementById('pushAllToTeleBtn');
    if (this.pushAllToTeleBtn) {
      this.pushAllToTeleBtn.addEventListener('click', async () => {
        if (!this.teleCloud.enabled) { alert('Hãy nhập mã nhóm (và địa chỉ server nếu cần) trước.'); return; }
        const pending = this.tracks.filter(t => t.fileBlob && !t.cloudId);
        if (pending.length === 0) {
          this.showToast('☁️ Mọi bài trên máy này đều đã có trên cloud. Bấm "Đồng bộ" để lấy bài của mọi người.');
          return;
        }
        this.telegramModal.style.display = 'none';
        pending.forEach(t => this.enqueueCloudUpload(t));
        this.showToast(`☁️ Đã đưa ${pending.length} bài hát vào hàng đợi đẩy lên cloud!`);
      });
    }

    this.pullTeleTracksBtn.addEventListener('click', async () => {
      if (!this.teleCloud.enabled) { alert('Hãy nhập mã nhóm (và địa chỉ server nếu cần) trước.'); return; }
      this.pullTeleTracksBtn.disabled = true;
      this.pullTeleTracksBtn.textContent = 'Đang đồng bộ...';
      try {
        await this.pullLibrary();
      } catch (err) {
        alert('Lỗi đồng bộ: ' + err.message);
      }
      this.pullTeleTracksBtn.disabled = false;
      this.pullTeleTracksBtn.textContent = '🔄 Đồng bộ danh sách từ cloud';
    });

    // Spacebar to pause/play
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'BUTTON', 'TEXTAREA'].includes(e.target.tagName)) return;
      const adjustVol = (d) => {
        this.audio.volume = Math.max(0, Math.min(1, this.audio.volume + d));
        this.volumeSlider.value = this.audio.volume;
        this.updateVolumeIcon();
        this.saveSettings();
      };
      switch (e.code) {
        case 'Space': e.preventDefault(); this.togglePlay(); break;
        case 'ArrowRight': e.preventDefault(); this.audio.currentTime += 5; break;
        case 'ArrowLeft': e.preventDefault(); this.audio.currentTime -= 5; break;
        case 'ArrowUp': e.preventDefault(); adjustVol(0.05); break;
        case 'ArrowDown': e.preventDefault(); adjustVol(-0.05); break;
        case 'KeyM': this.volBtn.click(); break;
      }
    });

    // Lưu cài đặt sau mỗi lần thay đổi, rồi khôi phục cài đặt cũ
    [this.shuffleBtn, this.loopBtn, this.ambientToggleBtn, this.volBtn]
      .forEach(b => b.addEventListener('click', () => this.saveSettings()));
    this.volumeSlider.addEventListener('change', () => this.saveSettings());
    this.loadSettings();
    this.updateTeleStatus();
  }

  // Recursive folder file extractor for drag & drop
  async extractFilesFromDataTransfer(dataTransfer) {
    const files = [];
    const items = dataTransfer.items;
    if (items && items.length > 0 && items[0].webkitGetAsEntry) {
      const queue = [];
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry();
        if (entry) queue.push(entry);
      }
      while (queue.length > 0) {
        const entry = queue.shift();
        if (entry.isFile) {
          const file = await new Promise(res => entry.file(res, () => res(null)));
          if (file && (file.type.startsWith('audio/') || file.name.match(/\.(mp3|wav|flac|m4a|ogg|aac|webm)$/i))) {
            files.push(file);
          }
        } else if (entry.isDirectory) {
          const dirReader = entry.createReader();
          const entries = await new Promise(res => dirReader.readEntries(res, () => res([])));
          queue.push(...entries);
        }
      }
      return files;
    }

    if (dataTransfer.files && dataTransfer.files.length > 0) {
      for (let i = 0; i < dataTransfer.files.length; i++) {
        const f = dataTransfer.files[i];
        if (f.type.startsWith('audio/') || f.name.match(/\.(mp3|wav|flac|m4a|ogg|aac|webm)$/i)) {
          files.push(f);
        }
      }
    }
    return files;
  }

  // Handle file uploads: ZERO-WAIT INSTANT INGESTION + PARALLEL TAG EXTRACTION + BACKGROUND CLOUD SYNC
  async handleFileUpload(filesInput) {
    if (!filesInput || filesInput.length === 0) return;

    const validFiles = [];
    for (let i = 0; i < filesInput.length; i++) {
      const file = filesInput[i];
      if (file && (file.type.startsWith('audio/') || file.name.match(/\.(mp3|wav|flac|m4a|ogg|aac|webm)$/i))) {
        validFiles.push(file);
      }
    }
    if (validFiles.length === 0) return;

    const startIndex = this.tracks.length;
    const newTracks = [];

    // BƯỚC 1: NẠP VÀO GIAO DIỆN & PHÁT NGAY LẬP TỨC (0.05 giây)
    for (const file of validFiles) {
      let title = file.name.replace(/\.[^/.]+$/, '');
      let artist = 'Đang đọc thẻ...';
      if (title.includes(' - ')) {
        const parts = title.split(' - ');
        artist = parts[0].trim();
        title = parts.slice(1).join(' - ').trim();
      }

      const track = {
        id: 'track_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        title: title,
        artist: artist,
        album: '',
        coverUrl: null,
        fileBlob: file,
        cloudId: null,
        duration: 0
      };
      newTracks.push(track);
      this.tracks.push(track);
      let done;
      const p = new Promise(r => { done = r; });
      this.metaReady.set(track.id, { p, done });
    }

    // Lưu batch vào IndexedDB ngay lập tức
    await this.db.saveTracksBatch(newTracks);

    // Cập nhật ngay playlist trong 1 frame
    this.renderPlaylist();

    // Nếu chưa phát nhạc, kích hoạt phát ngay bài đầu tiên được nạp
    if (this.currentTrackIndex === -1 && this.tracks.length > 0) {
      this.selectTrack(startIndex, true);
    }

    this.showToast(`⚡ Đã nạp siêu tốc ${newTracks.length} bài hát vào danh sách!`);

    // BƯỚC 2: PHÂN TÍCH METADATA SONG SONG (PARALLEL WORKER POOL)
    const PARALLEL_LIMIT = 4;
    const extractQueue = [...newTracks];
    const worker = async () => {
      while (extractQueue.length > 0) {
        const track = extractQueue.shift();
        try {
          const meta = await extractMetadata(track.fileBlob);
          track.title = meta.title || track.title;
          track.artist = meta.artist || track.artist;
          track.album = meta.album || track.album;
          track.coverUrl = meta.coverUrl || track.coverUrl;
          await this.db.saveTrack(track);
          this.updateTrackInDOM(track);
        } catch (e) {
          console.warn('Metadata extract error:', e);
        } finally {
          const m = this.metaReady.get(track.id);
          if (m) m.done();
        }
      }
    };

    const workers = [];
    for (let i = 0; i < Math.min(PARALLEL_LIMIT, extractQueue.length); i++) {
      workers.push(worker());
    }
    // Chạy ngầm không chặn luồng chính
    Promise.all(workers);

    // BƯỚC 3: ĐỒNG BỘ TELEGRAM CLOUD CHẠY NỀN NGẦM (BACKGROUND QUEUE)
    if (this.teleCloud.enabled && this.teleCloud.autoSync) {
      for (const track of newTracks) {
        this.enqueueCloudUpload(track);
      }
    }
  }

  updateTrackInDOM(track) {
    const li = this.songList.querySelector(`[data-track-id="${track.id}"]`);
    if (li) {
      const titleEl = li.querySelector('.song-item-title');
      if (titleEl) titleEl.textContent = track.title;
      const artistEl = li.querySelector('.song-item-artist');
      if (artistEl) artistEl.textContent = track.artist;
      if (track.coverUrl) {
        const coverEl = li.querySelector('.song-item-cover');
        if (coverEl) coverEl.innerHTML = `<img src="${track.coverUrl}" alt="cover">`;
      }
    }

    if (this.currentTrackIndex >= 0 && this.tracks[this.currentTrackIndex]?.id === track.id) {
      this.songTitle.textContent = track.title;
      this.songArtist.textContent = track.artist;
      if (track.coverUrl && (!this.coverImg.src || this.coverImg.src !== track.coverUrl)) {
        this.coverImg.onload = async () => {
          const colors = await extractColorsFromImage(this.coverImg);
          this.applyAmbientColors(colors[0], colors[1]);
        };
        this.coverImg.src = track.coverUrl;
        this.coverImg.style.display = 'block';
        this.coverPlaceholder.style.display = 'none';
      }
    }
  }

  enqueueCloudUpload(track) {
    if (!this.teleCloud.enabled) return;
    if (track.cloudId || !track.fileBlob) return;
    if (this.uploadQueue.some(item => item.id === track.id)) return;

    this.uploadQueue.push(track);
    this.totalQueueItems++;
    this.updateCloudStatusInDOM(track.id, 'syncing');
    this.processUploadQueue();
  }

  async processUploadQueue() {
    if (this.isUploadingQueue) return;
    this.isUploadingQueue = true;

    this.teleBanner.style.display = 'block';
    const spinner = document.getElementById('teleSpinner');
    if (spinner) spinner.style.display = 'inline-block';

    let successCount = 0;
    let failCount = 0;
    let lastError = '';
    let fatal = false;

    while (this.uploadQueue.length > 0 && !fatal) {
      const track = this.uploadQueue.shift();
      const current = this.completedQueueItems + 1;
      const total = this.totalQueueItems;

      // Chờ đọc xong thẻ ID3 để gửi đúng tên bài / nghệ sĩ / ảnh bìa
      const meta = this.metaReady.get(track.id);
      if (meta) {
        await meta.p;
        this.metaReady.delete(track.id);
      }
      if (!this.tracks.includes(track)) { this.completedQueueItems++; continue; } // bài đã bị xóa khi đang chờ

      this.teleBannerText.textContent = `☁️ Đang gửi "${track.title}" lên server (${current}/${total})...`;
      this.updateCloudStatusInDOM(track.id, 'syncing');

      try {
        const res = await this.teleCloud.upload(track, (info) => {
          if (!info) return;
          if (typeof info === 'number') {
            this.teleBannerText.textContent = `☁️ Đang gửi "${track.title}" lên server: ${info}% (${current}/${total})...`;
            return;
          }
          if (info.phase === 'server') {
            const loadedMb = (info.loaded / (1024 * 1024)).toFixed(1);
            const totalMb = (info.total / (1024 * 1024)).toFixed(1);
            if (info.percent < 100) {
              this.teleBannerText.textContent = `☁️ [1/2 Máy ➡️ Server]: ${info.percent}% (${loadedMb}/${totalMb} MB) • (${current}/${total})...`;
            } else {
              this.teleBannerText.textContent = `☁️ [2/2 Server ➡️ Telegram]: Đang xử lý file ${totalMb} MB (${current}/${total})...`;
            }
          } else if (info.phase === 'telegram') {
            const speedStr = info.speedMbps ? ` • ${info.speedMbps} MB/s` : '';
            this.teleBannerText.textContent = `☁️ [2/2 Server ➡️ Telegram]: ${info.percent}% (${info.currentMb}/${info.totalMb} MB${speedStr}) • (${current}/${total})...`;
          }
        });
        if (res.ok) {
          if (!this.tracks.includes(track)) {
            this.teleCloud.remove(res.track.id); // bị xóa trong lúc đang gửi: dọn bản vừa lên
          } else {
            track.cloudId = res.track.id;
            await this.db.saveTrack(track);
            this.updateCloudStatusInDOM(track.id, 'synced');
            successCount++;
          }
        } else {
          console.warn('Upload failed:', res.reason, res.description);
          lastError = res.description || '';
          this.updateCloudStatusInDOM(track.id, 'failed', res.description);
          failCount++;
          // Sai mã / lỗi mạng / lỗi cấu hình thì các bài sau cũng sẽ lỗi y hệt: dừng sớm (tránh bị khóa do nhập sai mã nhiều lần)
          if (['auth', 'throttle', 'mixed', 'network'].includes(res.reason)) fatal = true;
        }
      } catch (err) {
        console.warn('Queue upload error:', err);
        lastError = err.message;
        this.updateCloudStatusInDOM(track.id, 'failed');
        failCount++;
      }

      this.completedQueueItems++;
    }

    if (fatal) {
      for (const t of this.uploadQueue) this.updateCloudStatusInDOM(t.id, 'failed', lastError);
      failCount += this.uploadQueue.length;
      this.uploadQueue = [];
      this.completedQueueItems = this.totalQueueItems;
    }

    if (spinner) spinner.style.display = 'none';

    if (failCount === 0) {
      this.teleBannerText.textContent = `✅ Đã đồng bộ hoàn tất ${successCount} bài hát lên cloud!`;
      this.showToast(`✅ Đã đồng bộ ${successCount} bài lên cloud!`);
    } else {
      this.teleBannerText.textContent = `⚠️ ${successCount} bài thành công, ${failCount} bài lỗi${lastError ? ': ' + lastError : ''}`;
      this.showToast(`⚠️ ${failCount} bài chưa lên được cloud: ${lastError || 'xem biểu tượng lỗi trên bài hát'}`, 6000);
    }

    setTimeout(() => {
      if (this.uploadQueue.length === 0) {
        this.teleBanner.style.display = 'none';
        this.totalQueueItems = 0;
        this.completedQueueItems = 0;
      }
    }, 4500);

    this.isUploadingQueue = false;
  }

  // ---- Đồng bộ danh sách với cloud (server quét lại kho nhạc trên Telegram) ----
  async pullLibrary() {
    const res = await this.teleCloud.list(true);
    if (!res.ok) {
      alert('Không đồng bộ được: ' + res.description);
      return;
    }
    const remote = res.data.tracks || [];
    const remoteIds = new Set(remote.map(r => r.id));
    const byCloud = new Map(this.tracks.filter(t => t.cloudId).map(t => [t.cloudId, t]));

    const added = [];
    const coverTodo = [];
    for (const r of remote) {
      if (byCloud.has(r.id)) continue;
      const t = {
        id: 'cloud_' + r.id,
        cloudId: r.id,
        title: r.title || 'Bài hát',
        artist: r.artist || 'Nghệ sĩ chưa rõ',
        album: r.album || '',
        coverUrl: null,
        duration: r.duration || 0
      };
      added.push(t);
      if (r.hasCover) coverTodo.push(t);
    }

    // Bài từng có trên cloud nhưng đã bị ai đó xóa
    const removed = [];
    const detached = [];
    for (const t of this.tracks) {
      if (t.cloudId && !remoteIds.has(t.cloudId)) {
        if (t.fileBlob) { t.cloudId = null; detached.push(t); } // vẫn còn file trên máy: giữ lại, thành bài chỉ có trên máy
        else removed.push(t);
      }
    }

    if (added.length === 0 && removed.length === 0 && detached.length === 0) {
      this.showToast(`✅ Đã khớp với cloud (${remote.length} bài).`);
      return;
    }

    const currentId = this.currentTrackIndex >= 0 ? this.tracks[this.currentTrackIndex].id : null;
    await this.db.saveTracksBatch([...added, ...detached]);
    for (const t of removed) await this.db.deleteTrack(t.id);
    this.tracks = this.tracks.filter(t => !removed.includes(t));
    this.tracks.push(...added);

    if (currentId && removed.some(t => t.id === currentId)) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.isPlaying = false;
      this.currentTrackIndex = -1;
      this.updatePlayState();
    } else {
      this.currentTrackIndex = currentId ? this.tracks.findIndex(t => t.id === currentId) : -1;
    }
    this.renderPlaylist();
    if (this.currentTrackIndex === -1 && this.tracks.length > 0) this.selectTrack(0, false);
    this.telegramModal.style.display = 'none';
    this.showToast(`🔄 Đồng bộ xong: +${added.length} bài mới, -${removed.length} bài đã bị xóa khỏi cloud.`);

    // Tải ảnh bìa nhỏ ở nền (tối đa 3 yêu cầu cùng lúc)
    const queue = [...coverTodo];
    const worker = async () => {
      while (queue.length > 0) {
        const t = queue.shift();
        const blob = await this.teleCloud.cover(t.cloudId);
        const dataUrl = blob ? await blobToDataUrl(blob) : null;
        if (dataUrl && this.tracks.includes(t)) {
          t.coverUrl = dataUrl;
          await this.db.saveTrack(t);
          this.updateTrackInDOM(t);
        }
      }
    };
    Promise.all([worker(), worker(), worker()]);
  }

  updateCloudStatusInDOM(trackId, status, note) {
    const li = this.songList.querySelector(`[data-track-id="${trackId}"]`);
    if (!li) return;
    const actions = li.querySelector('.song-item-actions');
    if (!actions) return;

    let cloudEl = actions.querySelector('.cloud-status-icon, .cloud-sync-btn');
    if (!cloudEl) {
      cloudEl = document.createElement('div');
      const delBtn = actions.querySelector('.delete-track-btn');
      if (delBtn) actions.insertBefore(cloudEl, delBtn);
      else actions.appendChild(cloudEl);
    }

    if (status === 'synced') {
      cloudEl.className = 'cloud-status-icon synced';
      cloudEl.title = 'Đã lưu vĩnh viễn trên Telegram Cloud';
      cloudEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><polyline points="9 13 12 16 16 11"/></svg>`;
    } else if (status === 'syncing') {
      cloudEl.className = 'cloud-status-icon syncing';
      cloudEl.title = 'Đang đồng bộ lên Telegram Cloud...';
      cloudEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" class="spin-icon"><path d="M21 12a9 9 0 1 1-6.219-8.56"/><polyline points="21 3 21 9 15 9"/></svg>`;
    } else if (status === 'failed') {
      cloudEl.className = 'cloud-status-icon failed';
      cloudEl.title = note || 'Lỗi đồng bộ. Bấm để thử lại';
      cloudEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><line x1="12" y1="12" x2="12" y2="15"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
    } else {
      cloudEl.className = 'cloud-sync-btn';
      cloudEl.title = 'Đồng bộ bài này lên Telegram Cloud';
      cloudEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><polyline points="12 13 12 9 10 11"/><polyline points="12 9 14 11"/></svg>`;
    }
  }

  renderPlaylist() {
    this.songList.innerHTML = '';
    this.trackCountBadge.textContent = `${this.tracks.length} bài hát`;

    if (this.tracks.length === 0) {
      this.emptyState.style.display = 'flex';
      this.songTitle.textContent = 'Chưa chọn bài hát';
      this.songArtist.textContent = 'Hãy tải file nhạc lên để thưởng thức';
      this.coverImg.style.display = 'none';
      this.coverPlaceholder.style.display = 'flex';
      return;
    }

    this.emptyState.style.display = 'none';

    this.tracks.forEach((track, idx) => {
      const li = document.createElement('li');
      li.className = `song-item ${idx === this.currentTrackIndex ? 'active' : ''}`;
      li.setAttribute('data-track-id', track.id);

      const isSynced = !!track.cloudId;
      const isSyncing = this.uploadQueue.some(item => item.id === track.id);

      let cloudBadgeHtml = '';
      if (isSynced) {
        cloudBadgeHtml = `
          <span class="cloud-status-icon synced" title="Đã lưu an toàn trên Telegram Cloud">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><polyline points="9 13 12 16 16 11"/></svg>
          </span>`;
      } else if (isSyncing) {
        cloudBadgeHtml = `
          <span class="cloud-status-icon syncing" title="Đang đồng bộ Telegram Cloud ngầm...">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" class="spin-icon"><path d="M21 12a9 9 0 1 1-6.219-8.56"/><polyline points="21 3 21 9 15 9"/></svg>
          </span>`;
      } else if (this.teleCloud.enabled) {
        cloudBadgeHtml = `
          <button class="cloud-sync-btn" title="Lưu bài này lên Telegram Cloud">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><polyline points="12 13 12 9 10 11"/><polyline points="12 9 14 11"/></svg>
          </button>`;
      }

      li.innerHTML = `
        <span class="song-item-idx">${idx + 1}</span>
        <div class="song-item-cover">
          ${track.coverUrl ? `<img src="${track.coverUrl}" alt="cover">` : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`}
        </div>
        <div class="song-item-info">
          <div class="song-item-title">${this.escapeHtml(track.title)}</div>
          <div class="song-item-artist">${this.escapeHtml(track.artist)}</div>
        </div>
        <div class="song-item-actions">
          ${cloudBadgeHtml}
          <button class="delete-track-btn" title="Xóa bài này">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      `;

      li.addEventListener('click', (e) => {
        if (e.target.closest('.delete-track-btn')) {
          e.stopPropagation();
          this.removeTrack(idx);
          return;
        }
        if (e.target.closest('.cloud-sync-btn') || e.target.closest('.cloud-status-icon.failed')) {
          e.stopPropagation();
          if (!this.teleCloud.enabled) {
            alert('Vui lòng cài đặt Bot Token và Chat ID trước.');
            this.telegramModal.style.display = 'flex';
            return;
          }
          this.enqueueCloudUpload(track);
          return;
        }
        this.selectTrack(idx, true);
      });

      this.songList.appendChild(li);
    });
    if (this.searchInput.value) this.searchInput.dispatchEvent(new Event('input'));
  }


  async removeTrack(index) {
    const track = this.tracks[index];
    const onCloud = this.teleCloud.enabled && !!track.cloudId;
    if (onCloud && !confirm('Bài này đang nằm trên cloud CHUNG của cả nhóm.\nXóa khỏi máy VÀ xóa luôn trên cloud? (mọi người sẽ không còn thấy bài này)')) return;
    this.uploadQueue = this.uploadQueue.filter(item => item.id !== track.id);
    await this.db.deleteTrack(track.id);
    if (onCloud) {
      this.teleCloud.remove(track.cloudId).then((r) => {
        if (!r.ok && r.status !== 404) this.showToast(`⚠️ Đã xóa trên máy nhưng chưa xóa được trên cloud: ${r.description}`, 6000);
      });
    }
    this.tracks.splice(index, 1);

    if (this.currentTrackIndex === index) {
      if (this.tracks.length > 0) {
        this.selectTrack(Math.min(index, this.tracks.length - 1), this.isPlaying);
      } else {
        this.currentTrackIndex = -1;
        this.audio.pause();
        this.audio.src = '';
        this.isPlaying = false;
        this.updatePlayState();
      }
    } else if (this.currentTrackIndex > index) {
      this.currentTrackIndex--;
    }

    this.renderPlaylist();
  }

  async selectTrack(index, autoPlay = true) {
    if (index < 0 || index >= this.tracks.length) return;
    this.currentTrackIndex = index;
    const track = this.tracks[index];

    // Create object URL from fileBlob or stream from Telegram
    const token = ++this.selectToken;
    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = null;
    }
    if (track.fileBlob) {
      this.currentObjectUrl = URL.createObjectURL(track.fileBlob);
      this.audio.src = this.currentObjectUrl;
    } else if (track.cloudId) {
      this.audio.src = this.teleCloud.streamUrl(track.cloudId); // phát dần từ server, tua được
    }

    // Update Meta UI
    this.songTitle.textContent = track.title;
    this.songArtist.textContent = track.artist;

    if (track.coverUrl) {
      // Gán onload TRƯỚC src để không bỏ lỡ sự kiện khi ảnh đã được cache
      this.coverImg.onload = async () => {
        const colors = await extractColorsFromImage(this.coverImg);
        this.applyAmbientColors(colors[0], colors[1]);
      };
      this.coverImg.src = track.coverUrl;
      this.coverImg.style.display = 'block';
      this.coverPlaceholder.style.display = 'none';
    } else {
      this.coverImg.style.display = 'none';
      this.coverPlaceholder.style.display = 'flex';
      const colors = stringToColor(track.title);
      this.applyAmbientColors(colors[0], colors[1]);
    }

    // Media Session for mobile lock screen / Windows bar
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album || 'AmbiMusic Collection',
        artwork: track.coverUrl ? [{ src: track.coverUrl, sizes: '512x512', type: 'image/png' }] : []
      });
      navigator.mediaSession.setActionHandler('play', () => this.togglePlay());
      navigator.mediaSession.setActionHandler('pause', () => this.togglePlay());
      navigator.mediaSession.setActionHandler('previoustrack', () => this.playPrev());
      navigator.mediaSession.setActionHandler('nexttrack', () => this.playNext());
    }

    // Highlight active in playlist
    const items = this.songList.querySelectorAll('.song-item');
    items.forEach((it, i) => it.classList.toggle('active', i === index));

    if (autoPlay) {
      this.startAudioContext();
      try {
        await this.audio.play();
        this.isPlaying = true;
      } catch (err) {
        console.warn('Playback blocked by browser policy:', err);
        this.isPlaying = false;
      }
    } else {
      this.isPlaying = false;
    }

    this.updatePlayState();
  }

  applyAmbientColors(c1, c2) {
    const root = document.documentElement;
    root.style.setProperty('--ambient-color-1', c1);
    root.style.setProperty('--ambient-color-2', c2);
  }

  async togglePlay() {
    if (this.tracks.length === 0) {
      this.showToast('🎧 Chưa có bài hát nào! Bấm "Tải nhạc lên" hoặc click nút "Nghe thử Demo" bên dưới.');
      return;
    }
    if (this.currentTrackIndex === -1) {
      this.selectTrack(0, true);
      return;
    }

    this.startAudioContext();

    if (this.isPlaying) {
      this.audio.pause();
      this.isPlaying = false;
      this.updatePlayState();
    } else {
      try {
        await this.audio.play();
        this.isPlaying = true;
        this.updatePlayState();
      } catch (err) {
        console.warn('Playback error or blocked by policy:', err);
        this.isPlaying = false;
        this.updatePlayState();
      }
    }
  }

  updatePlayState() {
    if (this.isPlaying) {
      this.coverWrapper.classList.add('is-playing');
      this.playIcon.innerHTML = `<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>`;
    } else {
      this.coverWrapper.classList.remove('is-playing');
      this.playIcon.innerHTML = `<polygon points="5 3 19 12 5 21 5 3"></polygon>`;
    }
  }

  playNext() {
    if (this.tracks.length === 0) return;
    if (this.isShuffle) {
      let nextIdx = Math.floor(Math.random() * this.tracks.length);
      if (this.tracks.length > 1 && nextIdx === this.currentTrackIndex) nextIdx = (nextIdx + 1) % this.tracks.length;
      this.selectTrack(nextIdx, true);
    } else {
      let nextIdx = this.currentTrackIndex + 1;
      if (nextIdx >= this.tracks.length) nextIdx = 0;
      this.selectTrack(nextIdx, true);
    }
  }

  playPrev() {
    if (this.tracks.length === 0) return;
    if (this.audio.currentTime > 3) {
      this.audio.currentTime = 0;
      return;
    }
    let prevIdx = this.currentTrackIndex - 1;
    if (prevIdx < 0) prevIdx = this.tracks.length - 1;
    this.selectTrack(prevIdx, true);
  }

  handleSongEnd() {
    if (this.loopMode === 2) {
      // Loop one
      this.audio.currentTime = 0;
      this.audio.play();
    } else if (this.loopMode === 1 || this.currentTrackIndex < this.tracks.length - 1) {
      this.playNext();
    } else {
      this.isPlaying = false;
      this.updatePlayState();
    }
  }

  updateProgress() {
    if (this.isSeeking) return;
    if (!this.audio.duration) return;
    const current = this.audio.currentTime;
    const duration = this.audio.duration;
    const pct = (current / duration) * 100;

    this.progressBarFill.style.width = `${pct}%`;
    this.progressBarThumb.style.left = `${pct}%`;
    this.currentTimeEl.textContent = this.formatTime(current);
  }

  updateVolumeIcon() {
    const v = this.audio.volume;
    if (v === 0) {
      this.volIcon.innerHTML = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line>`;
    } else if (v < 0.5) {
      this.volIcon.innerHTML = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>`;
    } else {
      this.volIcon.innerHTML = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>`;
    }
  }

  formatTime(secs) {
    if (isNaN(secs)) return '00:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  }

  escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ================= Realtime Web Audio Visualizer =================
  startAudioContext() {
    try {
      if (!this.audioCtx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new AudioCtx();
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 64;
        this.sourceNode = this.audioCtx.createMediaElementSource(this.audio);
        this.sourceNode.connect(this.analyser);
        this.analyser.connect(this.audioCtx.destination);
      }
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }
    } catch (e) {
      console.warn('Web Audio API initialized error:', e);
    }
  }

  setupVisualizer() {
    const canvas = document.getElementById('visualizerCanvas');
    const ctx = canvas.getContext('2d');

    const render = () => {
      requestAnimationFrame(render);

      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth, height = canvas.clientHeight;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      if (!this.analyser || !this.isPlaying) {
        // Idle calm pulse line
        ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
        for (let i = 0; i < 28; i++) {
          const barW = (width / 28) - 3;
          const barH = 3;
          ctx.fillRect(i * (barW + 3), (height - barH) / 2, barW, barH);
        }
        return;
      }

      const bufferLength = this.analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      this.analyser.getByteFrequencyData(dataArray);

      const barCount = 28;
      const barWidth = (width / barCount) - 3;

      for (let i = 0; i < barCount; i++) {
        const val = dataArray[i % bufferLength];
        const barHeight = Math.max(3, (val / 255) * height);
        const x = i * (barWidth + 3);
        const y = (height - barHeight) / 2;

        const grad = ctx.createLinearGradient(0, y, 0, y + barHeight);
        grad.addColorStop(0, '#ec4899');
        grad.addColorStop(0.5, '#a855f7');
        grad.addColorStop(1, '#6366f1');

        ctx.fillStyle = grad;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(x, y, barWidth, barHeight, 4);
        } else {
          ctx.rect(x, y, barWidth, barHeight);
        }
        ctx.fill();
      }
    };

    render();
  }
}

// Demo Audio Generator (Generates a cozy synth melody .wav blob if user has no files)
async function generateDemoSoundBlob() {
  const sampleRate = 44100;
  const duration = 8; // 8 seconds loop
  const totalSamples = sampleRate * duration;
  const numChannels = 2;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = totalSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF identifier
  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  // Generate cozy ambient chord progression (Cmaj7 - Am7 - Fmaj7 - G7)
  const chords = [
    [261.63, 329.63, 392.00, 493.88], // Cmaj7
    [220.00, 261.63, 329.63, 392.00], // Am7
    [174.61, 220.00, 261.63, 329.63], // Fmaj7
    [196.00, 246.94, 293.66, 349.23]  // G7
  ];

  let offset = 44;
  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const chordIdx = Math.floor((t / duration) * chords.length) % chords.length;
    const currentChord = chords[chordIdx];

    let sample = 0;
    currentChord.forEach((freq, idx) => {
      // Warm soft sine waves with subtle tremolo
      const tremolo = 0.8 + 0.2 * Math.sin(2 * Math.PI * 3 * t);
      sample += Math.sin(2 * Math.PI * freq * t) * (0.25 / (idx + 1)) * tremolo;
    });

    // Envelope fade in/out
    const fade = Math.min(1, Math.min(t / 0.2, (duration - t) / 0.2));
    sample = Math.max(-1, Math.min(1, sample * fade * 0.45));
    const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;

    view.setInt16(offset, intSample, true);
    view.setInt16(offset + 2, intSample, true);
    offset += 4;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

// Generate demo album art canvas image
function generateDemoCover() {
  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = 400;
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, 400, 400);
  grad.addColorStop(0, '#6366f1');
  grad.addColorStop(0.5, '#ec4899');
  grad.addColorStop(1, '#f59e0b');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 400, 400);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.font = 'bold 36px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('LO-FI CHILL', 200, 190);
  ctx.font = '20px sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.fillText('AmbiMusic Ambient Master', 200, 230);

  return canvas.toDataURL('image/png');
}

// Auto load demo track if completely empty
window.addEventListener('DOMContentLoaded', async () => {
  window.ambiPlayer = new PlayerController();

  // Close Telegram Banner button
  const closeTeleBanner = document.getElementById('closeTeleBanner');
  if (closeTeleBanner) {
    closeTeleBanner.addEventListener('click', () => {
      document.getElementById('teleBanner').style.display = 'none';
    });
  }

  // Demo audio button in empty state
  const demoBtn = document.getElementById('demoBtn');
  if (demoBtn) {
    demoBtn.addEventListener('click', async () => {
      demoBtn.disabled = true;
      demoBtn.textContent = 'Đang khởi tạo nhạc mẫu...';
      const wavBlob = await generateDemoSoundBlob();
      const demoCover = generateDemoCover();
      const track = {
        id: 'demo_' + Date.now(),
        title: 'Midnight Chill (Ambient Demo)',
        artist: 'AmbiMusic Studio',
        album: 'Lo-Fi Chill Sessions',
        coverUrl: demoCover,
        fileBlob: wavBlob,
        duration: 8
      };
      await window.ambiPlayer.db.saveTrack(track);
      window.ambiPlayer.tracks.push(track);
      window.ambiPlayer.renderPlaylist();
      window.ambiPlayer.selectTrack(window.ambiPlayer.tracks.length - 1, true);
      demoBtn.disabled = false;
      demoBtn.textContent = '✨ Nghe thử nhạc mẫu Ambient Demo';
    });
  }

  // Register PWA Service Worker (Chỉ chạy trên HTTP/HTTPS hoặc localhost, tránh lỗi SecurityError trên protocol file://)
  if ('serviceWorker' in navigator && (window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('./sw.js').catch(err => console.log('SW registration skipped:', err));
  }
});