const express = require('express');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = 'cooldowns.json';

app.use(express.json());

// Load DB
let db = {};
if (fs.existsSync(DB_FILE)) {
    try {
        db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (err) {
        db = {};
    }
}

function saveDb() {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Set cooldown
app.post('/set_cooldown', (req, res) => {
    const { username, cooldown_seconds } = req.body;
    if (!username || typeof cooldown_seconds !== 'number') {
        return res.status(400).json({ error: "Invalid parameters" });
    }
    
    // Calculate the future timestamp when the cooldown expires
    const expire_timestamp = Math.floor(Date.now() / 1000) + cooldown_seconds;
    
    db[username] = {
        expire_timestamp: expire_timestamp
    };
    saveDb();
    
    console.log(`[+] Cooldown for ${username} updated. Expires at: ${new Date(expire_timestamp * 1000).toLocaleString()}`);
    res.json({ success: true, expire_timestamp });
});

// Get cooldown
app.get('/get_cooldown', (req, res) => {
    const username = req.query.username;
    if (!username) {
        return res.status(400).json({ error: "Missing username" });
    }
    
    const user_data = db[username];
    if (!user_data) {
        return res.json({ remaining_seconds: 0 }); // No cooldown
    }
    
    const now = Math.floor(Date.now() / 1000);
    const remaining = user_data.expire_timestamp - now;
    
    if (remaining <= 0) {
        // Cooldown expired
        delete db[username];
        saveDb();
        return res.json({ remaining_seconds: 0 });
    }
    
    res.json({ remaining_seconds: remaining });
});

// Dashboard
app.get('/', (req, res) => {
    let html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Raid Cooldown Dashboard</title>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #121212; color: #ffffff; padding: 20px; }
            h1 { text-align: center; color: #00e676; }
            table { width: 100%; max-width: 800px; margin: 0 auto; border-collapse: collapse; background-color: #1e1e1e; box-shadow: 0 4px 8px rgba(0,0,0,0.3); border-radius: 8px; overflow: hidden; }
            th, td { padding: 15px; text-align: left; border-bottom: 1px solid #333; }
            th { background-color: #2c2c2c; color: #00e676; font-weight: bold; }
            tr:hover { background-color: #2a2a2a; }
            .ready { color: #00e676; font-weight: bold; }
            .cooldown { color: #ff5252; }
            .time { font-family: monospace; font-size: 1.1em; }
        </style>
        <meta http-equiv="refresh" content="30">
    </head>
    <body>
        <h1>Raid Cooldown Dashboard</h1>
        <table>
            <thead>
                <tr>
                    <th>Tên Tài Khoản</th>
                    <th>Trạng Thái</th>
                    <th>Thời Gian Chờ Còn Lại</th>
                    <th>Hết Hạn Lúc</th>
                </tr>
            </thead>
            <tbody>
    `;

    const now = Math.floor(Date.now() / 1000);
    let accounts = Object.keys(db);
    
    if (accounts.length === 0) {
        html += `<tr><td colspan="4" style="text-align: center;">Chưa có dữ liệu account nào.</td></tr>`;
    } else {
        accounts.forEach(username => {
            const user_data = db[username];
            const remaining = user_data.expire_timestamp - now;
            
            if (remaining <= 0) {
                // Sẵn sàng
                html += `
                <tr>
                    <td>${username}</td>
                    <td class="ready">Sẵn Sàng Raid</td>
                    <td class="time">00:00:00</td>
                    <td>-</td>
                </tr>`;
            } else {
                // Đang cooldown
                const h = Math.floor(remaining / 3600);
                const m = Math.floor((remaining % 3600) / 60);
                const s = remaining % 60;
                const timeString = `${h.toString().padStart(2, '0')}h ${m.toString().padStart(2, '0')}m ${s.toString().padStart(2, '0')}s`;
                const expireDate = new Date(user_data.expire_timestamp * 1000).toLocaleString('vi-VN');

                html += `
                <tr>
                    <td>${username}</td>
                    <td class="cooldown">Đang Cooldown</td>
                    <td class="time">${timeString}</td>
                    <td>${expireDate}</td>
                </tr>`;
            }
        });
    }

    html += `
            </tbody>
        </table>
        <p style="text-align: center; margin-top: 20px; color: #888;">Tự động làm mới sau mỗi 30 giây</p>
    </body>
    </html>
    `;
    
    res.send(html);
});


app.listen(PORT, '0.0.0.0', () => {
    console.log(`Raid Cooldown Server running on port ${PORT}`);
});
