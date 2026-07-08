/**
 * Railway Coordinator Server
 * - Giao diện web để cập nhật JobID (có đăng nhập mật khẩu)
 * - Phân phối JobID tuần tự không trùng lặp cho nhiều client Lua
 */

const express = require("express");
const fs      = require("fs");
const path    = require("path");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Config ───────────────────────────────────────────────────────────────────
const API_KEY   = process.env.API_KEY || "admin123"; // Đặt biến môi trường API_KEY trên Railway
const DATA_DIR  = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, "data.json");

// Discord webhook giờ nằm ở SERVER, không còn nằm trong Lua client nữa.
// Đặt biến môi trường DISCORD_WEBHOOK_URL trên Railway.
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

// ─── Persistent storage ───────────────────────────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      return {
        servers: Array.isArray(parsed.servers) ? parsed.servers : [],
        targets: Array.isArray(parsed.targets) ? parsed.targets : [],
      };
    }
  } catch (err) {
    console.error("❌ [LOAD] Lỗi đọc data.json:", err.message);
  }
  return { servers: [], targets: [] };
}

function saveData(servers, targets) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ servers, targets }, null, 2), "utf8");
    console.log(`💾 [SAVE] servers=${servers.length} targets=${targets.length}`);
  } catch (err) {
    console.error("❌ [SAVE] Lỗi ghi data.json:", err.message);
  }
}

// ─── State ────────────────────────────────────────────────────────────────────
const initialData = loadData();
let serverList    = initialData.servers;
let targetItems   = initialData.targets; // tên item đã lowercase + trim
let globalCounter = 0;
let skippedSet    = new Set();

// Log dữ liệu quét nhận về (chỉ lưu trong RAM, mất khi restart — dùng /data/clear để dọn tay)
const SCAN_LOG_MAX = 300;
let scanLog = [];

console.log(`📂 [LOAD] servers=${serverList.length} targets=${targetItems.length}`);

function getNextValidIndex() {
  if (serverList.length === 0) return null;
  const activeCount = serverList.filter((id) => !skippedSet.has(id)).length;
  if (activeCount === 0) {
    console.log("[RESET] Hết vòng, reset skip set.");
    skippedSet.clear();
  }
  const total = serverList.length;
  for (let i = 0; i < total; i++) {
    const idx = (globalCounter + i) % total;
    const id  = serverList[idx];
    if (!skippedSet.has(id)) {
      globalCounter = (idx + 1) % total;
      return { index: idx, jobId: id };
    }
  }
  return null;
}

// ─── Discord Notifier (hàng đợi, tôn trọng rate-limit của Discord) ───────────
// Trước đây MỖI client Lua tự bắn webhook -> nhiều instance cùng lúc dễ dính
// 429 từ Discord. Giờ chỉ SERVER là điểm duy nhất gọi Discord, xử lý tuần tự
// qua hàng đợi nên không bao giờ bắn quá nhanh nữa.
const discordQueue = [];
let discordBusy = false;

function queueDiscordMessage(payload) {
  discordQueue.push(payload);
  processDiscordQueue();
}

async function processDiscordQueue() {
  if (discordBusy) return;
  discordBusy = true;

  while (discordQueue.length > 0) {
    const payload = discordQueue.shift();

    if (!DISCORD_WEBHOOK_URL) {
      console.warn("⚠️ [DISCORD] Chưa cấu hình DISCORD_WEBHOOK_URL, bỏ qua gửi.");
      continue;
    }

    try {
      const res = await fetch(DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || 1;
        console.warn(`⏳ [DISCORD] 429, đợi ${retryAfter}s rồi gửi lại...`);
        discordQueue.unshift(payload); // đưa lại đầu hàng đợi để không mất tin
        await new Promise((r) => setTimeout(r, retryAfter * 1000 + 200));
        continue;
      }

      if (!res.ok) {
        console.error(`❌ [DISCORD] HTTP ${res.status}: ${await res.text()}`);
      } else {
        console.log("✅ [DISCORD] Đã gửi thông báo");
      }
    } catch (err) {
      console.error("❌ [DISCORD] Lỗi gửi:", err.message);
    }

    await new Promise((r) => setTimeout(r, 500)); // giãn cách an toàn giữa các lần gửi
  }

  discordBusy = false;
}

function buildFishstrapLink(placeId, jobId) {
  return `https://www.fishstrap.app/v1/joingame?placeId=${placeId || ""}&gameInstanceId=${jobId}`;
}

function buildJoinScript(jobId) {
  return `-- [[ JOIN SERVER BY JOBID ]] --
local TeleportService = game:GetService("TeleportService")
local Players = game:GetService("Players")
local jobId = "${jobId}" -- Dán JobId bạn muốn vào đây
TeleportService:TeleportToPlaceInstance(game.PlaceId, jobId, Players.LocalPlayer)`;
}

function buildMerchantPayload(matched, jobId, placeId, position) {
  const fields = matched.map((it) => ({
    name: "🛒 " + it.name,
    value: `**Số lượng:** x${it.quantity}\n💴 **Yên:** ${it.yen}`,
    inline: true,
  }));

  const posText = position
    ? `X: ${Number(position.x).toFixed(1)}, Y: ${Number(position.y).toFixed(1)}, Z: ${Number(position.z).toFixed(1)}`
    : "N/A";

  return {
    content: `🛒 **TRAVELING MERCHANT ĐÃ XUẤT HIỆN!**\nItem bạn theo dõi: **${matched.map((m) => m.name).join(", ")}** đã có hàng!`,
    embeds: [
      {
        title: "📦 DANH SÁCH HÀNG HÓA (KHỚP TARGET)",
        color: 3066993,
        fields: [
          ...fields,
          { name: "📍 Vị trí NPC", value: posText, inline: false },
          { name: "🔑 Job ID", value: "```" + jobId + "```", inline: false },
          { name: "🔗 Join Link (Fishstrap)", value: buildFishstrapLink(placeId, jobId), inline: false },
          { name: "📋 Lua Script Join", value: "```lua\n" + buildJoinScript(jobId) + "\n```", inline: false },
        ],
        footer: { text: "Merchant Filter Bot" },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

// ─── SSE (Server-Sent Events) — đẩy dữ liệu quét về dashboard real-time ──────
// Thay vì phải chờ Discord (giới hạn ~2s/tin), dashboard nhận trực tiếp qua
// đường ống HTTP mở sẵn này -> gần như tức thời, không giới hạn tốc độ.
const sseClients = new Set();

function broadcastSSE(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch (_) { sseClients.delete(client); }
  }
}

// ─── Middleware xác thực API Key (cho Lua client) ─────────────────────────────
function apiAuth(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.key;
  if (key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ─── Giao diện Web ───────────────────────────────────────────────────────────

// Trang login
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Merchant Coordinator</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', sans-serif;
      background: #0f0f0f;
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 12px;
      padding: 40px;
      width: 360px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    }
    h1 { font-size: 20px; margin-bottom: 8px; color: #fff; }
    p  { font-size: 13px; color: #888; margin-bottom: 28px; }
    label { font-size: 13px; color: #aaa; display: block; margin-bottom: 6px; }
    input[type=password] {
      width: 100%;
      padding: 10px 14px;
      background: #111;
      border: 1px solid #444;
      border-radius: 8px;
      color: #fff;
      font-size: 14px;
      outline: none;
      transition: border 0.2s;
    }
    input[type=password]:focus { border-color: #4f8ef7; }
    button {
      width: 100%;
      margin-top: 18px;
      padding: 11px;
      background: #4f8ef7;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover { background: #3a7ae0; }
    .error {
      margin-top: 14px;
      padding: 10px 14px;
      background: #2a1010;
      border: 1px solid #c0392b;
      border-radius: 8px;
      color: #e74c3c;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>🔐 Merchant Coordinator</h1>
    <p>Đăng nhập để quản lý danh sách JobID</p>
    <form method="POST" action="/login">
      <label>Mật khẩu</label>
      <input type="password" name="password" placeholder="Nhập mật khẩu..." autofocus>
      <button type="submit">Đăng nhập</button>
    </form>
    ${req.query.err ? '<div class="error">❌ Mật khẩu không đúng!</div>' : ""}
  </div>
</body>
</html>`);
});

// Xử lý login — dùng redirect đơn giản với key trên URL (stateless)
app.post("/login", (req, res) => {
  const { password } = req.body;
  if (password !== API_KEY) {
    return res.redirect("/?err=1");
  }
  res.redirect("/dashboard?key=" + encodeURIComponent(API_KEY));
});

// Trang dashboard quản lý JobID
app.get("/dashboard", (req, res) => {
  const key = req.query.key;
  if (key !== API_KEY) return res.redirect("/");

  const total      = serverList.length;
  const skipCount  = skippedSet.size;
  const activeCount = total - serverList.filter(id => skippedSet.has(id)).length;

  res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard - Merchant Coordinator</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', sans-serif;
      background: #0f0f0f;
      color: #e0e0e0;
      padding: 32px 16px;
    }
    .container { max-width: 700px; margin: 0 auto; }
    h1 { font-size: 22px; color: #fff; margin-bottom: 6px; }
    .sub { color: #666; font-size: 13px; margin-bottom: 28px; }

    .stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      margin-bottom: 28px;
    }
    .stat {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 10px;
      padding: 16px;
      text-align: center;
    }
    .stat .num { font-size: 28px; font-weight: 700; color: #4f8ef7; }
    .stat .lbl { font-size: 12px; color: #666; margin-top: 4px; }

    .card {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 20px;
    }
    .card h2 { font-size: 15px; color: #fff; margin-bottom: 6px; }
    .card p  { font-size: 12px; color: #666; margin-bottom: 14px; }

    textarea {
      width: 100%;
      height: 220px;
      background: #111;
      border: 1px solid #333;
      border-radius: 8px;
      color: #e0e0e0;
      font-size: 13px;
      font-family: monospace;
      padding: 12px;
      outline: none;
      resize: vertical;
      transition: border 0.2s;
    }
    textarea:focus { border-color: #4f8ef7; }

    .actions { display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
    button {
      padding: 10px 20px;
      border: none;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    .btn-primary { background: #4f8ef7; color: #fff; }
    .btn-primary:hover { background: #3a7ae0; }
    .btn-danger  { background: #c0392b; color: #fff; }
    .btn-danger:hover  { background: #a93226; }
    .btn-secondary { background: #2a2a2a; color: #aaa; border: 1px solid #444; }
    .btn-secondary:hover { background: #333; }

    .toast {
      display: none;
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #27ae60;
      color: #fff;
      padding: 12px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      z-index: 999;
    }
    .toast.err { background: #c0392b; }

    .current-list {
      font-family: monospace;
      font-size: 12px;
      color: #888;
      background: #111;
      border: 1px solid #222;
      border-radius: 8px;
      padding: 12px;
      max-height: 160px;
      overflow-y: auto;
      line-height: 1.8;
      word-break: break-all;
    }

    .alert-banner {
      display: none;
      position: sticky;
      top: 0;
      z-index: 1000;
      background: #c0392b;
      color: #fff;
      padding: 14px 20px;
      margin: -32px -16px 20px -16px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      animation: pulse 1s infinite;
    }
    .alert-banner .title { font-weight: 700; font-size: 15px; margin-bottom: 6px; }
    .alert-banner .body  { font-size: 13px; opacity: 0.95; margin-bottom: 10px; }
    .alert-banner .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .alert-banner button {
      padding: 8px 16px; border: none; border-radius: 6px;
      font-size: 12px; font-weight: 700; cursor: pointer;
    }
    .alert-banner .btn-view { background: #fff; color: #c0392b; }
    .alert-banner .btn-copy { background: rgba(255,255,255,0.2); color: #fff; }
    @keyframes pulse {
      0%, 100% { background: #c0392b; }
      50%      { background: #e74c3c; }
    }

    .scan-item {
      background: #111;
      border: 1px solid #222;
      border-radius: 8px;
      padding: 12px 14px;
      margin-bottom: 8px;
      font-size: 12px;
    }
    .scan-item.matched { border-color: #27ae60; background: #0f1a12; }
    .scan-item .row1 { display: flex; justify-content: space-between; color: #666; margin-bottom: 6px; }
    .scan-item .row1 .time { font-family: monospace; }
    .scan-item .row1 .matched-tag { color: #27ae60; font-weight: 700; }
    .scan-item .items { color: #aaa; line-height: 1.6; }
    .scan-item .jobid { font-family: monospace; color: #4f8ef7; word-break: break-all; }
    .scan-item .mini-actions { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
    .scan-item .mini-actions button {
      padding: 4px 10px; font-size: 11px; border: 1px solid #333;
      background: #1a1a1a; color: #aaa; border-radius: 6px; cursor: pointer;
    }
    .scan-item .mini-actions button:hover { background: #2a2a2a; }
    .scan-log-wrap { max-height: 480px; overflow-y: auto; }
    .empty-hint { color: #555; font-size: 12px; text-align: center; padding: 20px; }
  </style>
</head>
<body>
  <div class="alert-banner" id="alertBanner">
    <div class="title" id="alertTitle">🚨 KHỚP TARGET!</div>
    <div class="body" id="alertBody"></div>
    <div class="actions">
      <button class="btn-view" onclick="dismissAlert()">👁️ Xem (tắt chuông)</button>
      <button class="btn-copy" onclick="copyText(currentAlert && currentAlert.jobId)">📋 Copy JobID</button>
      <button class="btn-copy" onclick="copyText(currentAlert && currentAlert.joinScript)">📋 Copy Script Join</button>
    </div>
  </div>
  <div class="container">
    <h1>📦 Merchant Coordinator</h1>
    <div class="sub">Quản lý danh sách JobID server</div>

    <div class="stats">
      <div class="stat">
        <div class="num" id="stat-total">${total}</div>
        <div class="lbl">Tổng JobID</div>
      </div>
      <div class="stat">
        <div class="num" id="stat-active" style="color:#27ae60">${activeCount}</div>
        <div class="lbl">Đang hoạt động</div>
      </div>
      <div class="stat">
        <div class="num" id="stat-skip" style="color:#e67e22">${skipCount}</div>
        <div class="lbl">Đã skip (có NPC)</div>
      </div>
    </div>

    <div class="card">
      <h2>📝 Cập nhật danh sách JobID</h2>
      <p>Mỗi dòng 1 JobID — khi lưu sẽ <strong style="color:#e74c3c">thay thế hoàn toàn</strong> danh sách cũ và reset counter</p>
      <textarea id="jobInput" placeholder="Dán JobID vào đây, mỗi dòng 1 ID&#10;Ví dụ:&#10;98a8a07d-d2a0-4b59-b048-36def963cbc6&#10;862eb531-8985-49d9-8dcd-9ffcc112fe56"></textarea>
      <div class="actions">
        <button class="btn-primary" onclick="updateServers()">💾 Lưu & thay thế</button>
        <button class="btn-secondary" onclick="loadCurrent()">📋 Xem list hiện tại</button>
        <button class="btn-danger" onclick="resetCounter()">🔄 Reset counter</button>
      </div>
    </div>

    <div class="card" id="currentCard" style="display:none">
      <h2>📋 Danh sách JobID hiện tại</h2>
      <p id="currentMeta"></p>
      <div class="current-list" id="currentList"></div>
    </div>

    <div class="card">
      <h2>🎯 Target mặt hàng cần theo dõi</h2>
      <p>Mỗi dòng 1 tên mặt hàng (không phân biệt hoa/thường). Chỉ mặt hàng bán bằng <strong style="color:#e74c3c">Yên</strong> mới được xét — AC Coin sẽ bị bỏ qua. Khi khớp, server sẽ tự gửi Discord.</p>
      <textarea id="targetInput" placeholder="Mỗi dòng 1 tên mặt hàng&#10;Ví dụ:&#10;Talent Reroll&#10;Marking Color Reroll"></textarea>
      <div class="actions">
        <button class="btn-primary" onclick="updateTargets()">💾 Lưu target</button>
        <button class="btn-secondary" onclick="loadTargets()">📋 Xem target hiện tại</button>
      </div>
    </div>

    <div class="card" id="targetCard" style="display:none">
      <h2>🎯 Target hiện tại</h2>
      <p id="targetMeta"></p>
      <div class="current-list" id="targetList"></div>
    </div>

    <div class="card">
      <h2>📡 Dữ liệu quét nhận về <span id="connStatus" style="font-size:11px;color:#666">(đang kết nối...)</span></h2>
      <p>Cập nhật real-time mỗi khi có client quét xong. Mục có viền xanh là khớp target — chuông sẽ tự kêu tới khi bạn bấm "Xem".</p>
      <div class="actions" style="margin-top:0; margin-bottom:14px;">
        <button class="btn-danger" onclick="clearData()">🧹 Xóa dữ liệu (/clear)</button>
        <button class="btn-secondary" onclick="loadDataLog()">🔄 Tải lại</button>
      </div>
      <div class="scan-log-wrap" id="scanLogWrap">
        <div class="empty-hint">Chưa có dữ liệu nào được quét...</div>
      </div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    const KEY = "${API_KEY}";

    function showToast(msg, isErr) {
      const t = document.getElementById("toast");
      t.textContent = msg;
      t.className = "toast" + (isErr ? " err" : "");
      t.style.display = "block";
      setTimeout(() => t.style.display = "none", 3000);
    }

    async function updateServers() {
      const raw = document.getElementById("jobInput").value.trim();
      if (!raw) return showToast("❌ Chưa nhập JobID!", true);

      const servers = raw.split("\\n")
        .map(s => s.trim())
        .filter(s => s.length > 0);

      if (servers.length === 0) return showToast("❌ Không có JobID hợp lệ!", true);

      const res = await fetch("/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": KEY },
        body: JSON.stringify({ servers })
      });
      const data = await res.json();

      if (res.ok) {
        showToast("✅ Đã cập nhật " + data.total + " JobID!");
        document.getElementById("stat-total").textContent  = data.total;
        document.getElementById("stat-active").textContent = data.total;
        document.getElementById("stat-skip").textContent   = 0;
        document.getElementById("jobInput").value = "";
        document.getElementById("currentCard").style.display = "none";
      } else {
        showToast("❌ " + (data.error || "Lỗi không xác định"), true);
      }
    }

    async function loadCurrent() {
      const res  = await fetch("/servers?key=" + KEY);
      const data = await res.json();
      const card = document.getElementById("currentCard");
      document.getElementById("currentMeta").textContent =
        "Tổng " + data.total + " JobID | Counter: " + data.counter;
      document.getElementById("currentList").innerHTML =
        data.servers.map((id, i) => \`<span style="color:#555">\${i+1}.</span> \${id}\`).join("<br>");
      card.style.display = "block";
    }

    async function updateTargets() {
      const raw = document.getElementById("targetInput").value.trim();
      if (!raw) return showToast("❌ Chưa nhập mặt hàng!", true);

      const targets = raw.split("\\n")
        .map(s => s.trim())
        .filter(s => s.length > 0);

      const res = await fetch("/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": KEY },
        body: JSON.stringify({ targets })
      });
      const data = await res.json();

      if (res.ok) {
        showToast("✅ Đã lưu " + data.total + " target!");
        document.getElementById("targetInput").value = "";
        document.getElementById("targetCard").style.display = "none";
      } else {
        showToast("❌ " + (data.error || "Lỗi không xác định"), true);
      }
    }

    async function loadTargets() {
      const res  = await fetch("/targets?key=" + KEY);
      const data = await res.json();
      const card = document.getElementById("targetCard");
      document.getElementById("targetMeta").textContent = "Tổng " + data.total + " target";
      document.getElementById("targetList").innerHTML =
        data.targets.map((name, i) => \`<span style="color:#555">\${i+1}.</span> \${name}\`).join("<br>") || "<em>Chưa có target nào</em>";
      card.style.display = "block";
    }

    async function resetCounter() {
      if (!confirm("Reset counter và skip set?")) return;
      const res = await fetch("/reset?key=" + KEY, { method: "POST" });
      if (res.ok) {
        showToast("✅ Đã reset counter và skip set!");
        document.getElementById("stat-skip").textContent = 0;
      }
    }

    // ─────────────────────────────────────────────────────────────
    //  DỮ LIỆU QUÉT REAL-TIME (SSE) + CẢNH BÁO ÂM THANH
    // ─────────────────────────────────────────────────────────────
    let scanEvents     = [];   // danh sách hiển thị (mới nhất ở cuối)
    let scanEventsById = {};   // tra cứu nhanh theo id, tránh nhét chuỗi thô vào onclick
    let alertQueue     = [];
    let currentAlert   = null;
    let audioCtx       = null;
    let alarmTimer     = null;

    function escapeHtml(s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }

    function fmtTime(iso) {
      try { return new Date(iso).toLocaleTimeString("vi-VN"); } catch (e) { return iso; }
    }

    function addScanEvent(ev) {
      scanEvents.push(ev);
      scanEventsById[ev.id] = ev;
      if (scanEvents.length > 300) {
        const removed = scanEvents.shift();
        delete scanEventsById[removed.id];
      }
    }

    function renderScanLog() {
      const wrap = document.getElementById("scanLogWrap");
      if (scanEvents.length === 0) {
        wrap.innerHTML = '<div class="empty-hint">Chưa có dữ liệu nào được quét...</div>';
        return;
      }
      let html = "";
      for (let i = scanEvents.length - 1; i >= 0; i--) {
        const ev = scanEvents[i];
        const isMatched = ev.matched && ev.matched.length > 0;
        const matchedTag = isMatched ? '<span class="matched-tag">🎯 KHỚP ' + ev.matched.length + ' MÓN</span>' : '';
        const itemsText = (ev.items || []).map(function (it) {
          let line = escapeHtml(it.name) + " x" + escapeHtml(it.quantity);
          if (it.yen) line += " — 💴 " + escapeHtml(it.yen);
          if (it.ac_coin) line += " — 🪙 " + escapeHtml(it.ac_coin);
          return line;
        }).join("<br>");

        html += '<div class="scan-item' + (isMatched ? " matched" : "") + '">'
          + '<div class="row1"><span class="time">' + fmtTime(ev.receivedAt) + '</span>' + matchedTag + '</div>'
          + '<div class="items">' + itemsText + '</div>'
          + '<div class="jobid">JobID: ' + escapeHtml(ev.jobId) + '</div>'
          + '<div class="mini-actions">'
          +   '<button onclick="copyJobId(\'' + ev.id + '\')">📋 Copy JobID</button>'
          +   '<button onclick="copyScript(\'' + ev.id + '\')">📋 Copy Script Join</button>'
          + '</div>'
          + '</div>';
      }
      wrap.innerHTML = html;
    }

    function copyText(text, label) {
      if (!text) return;
      navigator.clipboard.writeText(text).then(
        function () { showToast("✅ Đã copy " + (label || "") + "!"); },
        function () { showToast("❌ Copy thất bại", true); }
      );
    }
    function copyJobId(id) {
      const ev = scanEventsById[id];
      if (ev) copyText(ev.jobId, "JobID");
    }
    function copyScript(id) {
      const ev = scanEventsById[id];
      if (ev) copyText(ev.joinScript, "Script Join");
    }

    // ── Chuông cảnh báo (Web Audio, không cần file mp3) ──
    function startAlarm() {
      if (alarmTimer) return;
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      alarmTimer = setInterval(function () {
        try {
          const osc  = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.frequency.value = 880;
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
          osc.start();
          osc.stop(audioCtx.currentTime + 0.25);
        } catch (e) {}
      }, 700);
    }
    function stopAlarm() {
      if (alarmTimer) { clearInterval(alarmTimer); alarmTimer = null; }
    }

    function showAlert(ev) {
      alertQueue.push(ev);
      if (!currentAlert) advanceAlert();
      startAlarm();
    }
    function advanceAlert() {
      currentAlert = alertQueue.shift() || null;
      const banner = document.getElementById("alertBanner");
      if (!currentAlert) {
        banner.style.display = "none";
        stopAlarm();
        return;
      }
      document.getElementById("alertTitle").textContent =
        "🚨 KHỚP TARGET: " + currentAlert.matched.map(function (m) { return m.name; }).join(", ");
      document.getElementById("alertBody").textContent =
        "JobID: " + currentAlert.jobId + (alertQueue.length > 0 ? " — còn " + alertQueue.length + " cảnh báo khác đang chờ" : "");
      banner.style.display = "block";
    }
    function dismissAlert() {
      advanceAlert(); // hiện cảnh báo tiếp theo nếu còn, không thì ẩn banner + tắt chuông
    }

    async function loadDataLog() {
      try {
        const res  = await fetch("/data?key=" + KEY);
        const data = await res.json();
        scanEvents = [];
        scanEventsById = {};
        (data.events || []).forEach(addScanEvent);
        renderScanLog();
      } catch (e) {
        showToast("❌ Lỗi tải dữ liệu quét", true);
      }
    }

    async function clearData() {
      if (!confirm("Xóa toàn bộ dữ liệu quét đã nhận về? (không ảnh hưởng danh sách JobID/target)")) return;
      const res = await fetch("/data/clear", { method: "POST", headers: { "X-Api-Key": KEY } });
      if (res.ok) {
        scanEvents = [];
        scanEventsById = {};
        renderScanLog();
        showToast("✅ Đã xóa dữ liệu quét!");
      } else {
        showToast("❌ Xóa thất bại", true);
      }
    }

    function connectEvents() {
      const status = document.getElementById("connStatus");
      const es = new EventSource("/events?key=" + KEY);
      es.onopen = function () {
        status.textContent = "(đã kết nối)";
        status.style.color = "#27ae60";
      };
      es.onerror = function () {
        status.textContent = "(mất kết nối, đang thử lại...)";
        status.style.color = "#e67e22";
      };
      es.onmessage = function (e) {
        let ev;
        try { ev = JSON.parse(e.data); } catch (err) { return; }
        addScanEvent(ev);
        renderScanLog();
        if (ev.matched && ev.matched.length > 0) showAlert(ev);
      };
    }

    loadDataLog();
    connectEvents();
  </script>
</body>
</html>`);
});

// ─── API cho Lua client ───────────────────────────────────────────────────────

app.get("/claim", apiAuth, (req, res) => {
  const result = getNextValidIndex();
  if (!result) return res.status(503).json({ error: "Danh sách server trống!" });
  console.log(`[CLAIM] [${result.index + 1}/${serverList.length}]: ${result.jobId}`);
  res.json({ jobId: result.jobId, index: result.index + 1, total: serverList.length });
});

app.get("/servers", apiAuth, (req, res) => {
  res.json({ servers: serverList, total: serverList.length, counter: globalCounter });
});

app.post("/servers", apiAuth, (req, res) => {
  const { servers } = req.body;
  if (!Array.isArray(servers) || servers.length === 0) {
    return res.status(400).json({ error: 'Body phải có dạng: { "servers": [...] }' });
  }
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const invalid   = servers.filter((s) => !uuidRegex.test(s));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `${invalid.length} JobID không đúng UUID`, examples: invalid.slice(0, 3) });
  }
  serverList    = [...new Set(servers)];
  globalCounter = 0;
  skippedSet.clear();
  saveData(serverList, targetItems);
  res.json({ success: true, total: serverList.length });
});

// ─── Quản lý danh sách target (mặt hàng cần theo dõi) ─────────────────────────
app.get("/targets", apiAuth, (req, res) => {
  res.json({ targets: targetItems, total: targetItems.length });
});

app.post("/targets", apiAuth, (req, res) => {
  const { targets } = req.body;
  if (!Array.isArray(targets)) {
    return res.status(400).json({ error: 'Body phải có dạng: { "targets": [...] }' });
  }
  targetItems = [...new Set(targets.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
  saveData(serverList, targetItems);
  res.json({ success: true, total: targetItems.length, targets: targetItems });
});

// ─── Nhận dữ liệu quét từ Lua client, filter theo target, gửi Discord + SSE ───
app.post("/scan", apiAuth, (req, res) => {
  const { jobId, placeId, position, items } = req.body;
  if (!jobId || !Array.isArray(items)) {
    return res.status(400).json({ error: 'Body phải có dạng: { jobId, items: [...] }' });
  }

  // Chỉ xét mặt hàng có giá Yên (bỏ qua mặt hàng chỉ bán bằng AC Coin)
  const yenItems = items.filter((it) => it && it.yen && String(it.yen).trim() !== "");

  // Khớp với danh sách target (không phân biệt hoa/thường)
  const matched = targetItems.length === 0
    ? []
    : yenItems.filter((it) => targetItems.includes(String(it.name || "").trim().toLowerCase()));

  console.log(`[SCAN] jobId=${jobId} items=${items.length} yen=${yenItems.length} matched=${matched.length}`);

  // Lưu vào log (dashboard) + đẩy realtime qua SSE, dù có khớp target hay không —
  // để bên "Dữ liệu quét nhận về" thấy được toàn bộ hoạt động, còn chuông báo
  // chỉ kêu khi matched.length > 0 (xử lý ở phía client dashboard).
  const scanEvent = {
    id:         Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    receivedAt: new Date().toISOString(),
    jobId,
    placeId:    placeId || "",
    position:   position || null,
    items,
    matched,
    joinLink:   buildFishstrapLink(placeId, jobId),
    joinScript: buildJoinScript(jobId),
  };
  scanLog.push(scanEvent);
  if (scanLog.length > SCAN_LOG_MAX) scanLog.shift();
  broadcastSSE(scanEvent);

  if (matched.length > 0) {
    const payload = buildMerchantPayload(matched, jobId, placeId, position);
    queueDiscordMessage(payload);
  }

  res.json({ success: true, matched: matched.length, items: matched.map((m) => m.name) });
});

// ─── SSE stream cho dashboard (key truyền qua query vì EventSource không set header) ──
app.get("/events", apiAuth, (req, res) => {
  res.set({
    "Content-Type":  "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection":    "keep-alive",
  });
  res.flushHeaders();
  res.write("retry: 3000\n\n");

  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// ─── Dữ liệu quét đã nhận (cho dashboard load lại khi mở trang / F5) ─────────
app.get("/data", apiAuth, (req, res) => {
  res.json({ events: scanLog, total: scanLog.length });
});

app.post("/data/clear", apiAuth, (req, res) => {
  const count = scanLog.length;
  scanLog = [];
  console.log(`🧹 [CLEAR] Đã dọn ${count} bản ghi scan log`);
  res.json({ success: true, cleared: count });
});

app.post("/skip/:jobId", apiAuth, (req, res) => {
  skippedSet.add(req.params.jobId);
  res.json({ success: true, skipped: req.params.jobId, skipCount: skippedSet.size, total: serverList.length });
});

app.get("/status", apiAuth, (req, res) => {
  res.json({
    total:       serverList.length,
    counter:     globalCounter,
    skipCount:   skippedSet.size,
    activeCount: serverList.filter((id) => !skippedSet.has(id)).length,
  });
});

app.post("/reset", apiAuth, (req, res) => {
  globalCounter = 0;
  skippedSet.clear();
  res.json({ success: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server chạy trên port ${PORT}`);
  console.log(`📋 Tổng JobID: ${serverList.length}`);
  console.log(`🔑 API Key: ${API_KEY}`);
});
