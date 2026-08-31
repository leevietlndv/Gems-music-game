const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const { Telegraf, Markup } = require('telegraf');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- CẤU HÌNH BOT TELEGRAM ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null;

let isFormOpen = true;
let songs = [];
let lastWinner = null; // Lưu bài hát đang phát

// ĐỒNG BỘ TRẠNG THÁI BAO GỒM CẢ LASTWINNER
function broadcastState() {
  io.emit('stateUpdate', { isFormOpen, songs, lastWinner });
}

function performSpin() {
  // 1. Tự động xóa bài đang phát ở lượt trước
  if (lastWinner) {
    const index = songs.findIndex(s => s.url === lastWinner.url && s.user === lastWinner.user);
    if (index !== -1) {
      songs.splice(index, 1);
    }
    lastWinner = null;
  }

  // 2. Kiểm tra danh sách
  if (songs.length === 0) {
    broadcastState();
    return { success: false, message: 'Danh sách bài hát đã hết!' };
  }

  // 3. Chọn ngẫu nhiên bài mới
  const selectedIndex = Math.floor(Math.random() * songs.length);
  const winner = songs[selectedIndex];
  lastWinner = winner;

  broadcastState();
  io.emit('triggerSpin', { selectedIndex, winner });
  return { success: true, winner };
}

// --- LỆNH BOT TELEGRAM ---
if (bot) {
  bot.command('start', (ctx) => {
    const webAppUrl = process.env.WEB_APP_URL || 'https://vongquaynhac.onrender.com';
    ctx.reply(
      '🎵 **Chào mừng bạn đến với Vòng Quay Nhạc!**\nBấm nút bên dưới để mở giao diện quay bài hát:',
      Markup.inlineKeyboard([
        [Markup.button.webApp('🎡 Mở Vòng Quay Nhạc', webAppUrl)]
      ])
    );
  });

  bot.command('spin', (ctx) => {
    const result = performSpin();
    if (!result.success) {
      ctx.reply(`⚠️ ${result.message}`);
    } else {
      ctx.reply(`🎡 Đã quay! Bài trúng thưởng: ${result.winner.user} - ${result.winner.url}`);
    }
  });

  bot.command('toggle', (ctx) => {
    isFormOpen = !isFormOpen;
    broadcastState();
    ctx.reply(`📢 Trạng thái form: ${isFormOpen ? '🟢 Đang MỞ' : '🔴 Đã ĐÓNG'}`);
  });

  bot.command('reset', (ctx) => {
    songs = [];
    lastWinner = null;
    broadcastState();
    ctx.reply('🧹 Đã xóa sạch danh sách bài hát!');
  });

  bot.command('list', (ctx) => {
    if (songs.length === 0) {
      return ctx.reply('📋 Danh sách bài hát hiện đang trống.');
    }
    const listStr = songs.map((s, i) => `${i + 1}. ${s.user}: ${s.url}`).join('\n');
    ctx.reply(`📋 **Danh sách bài hát (${songs.length}):**\n\n${listStr}`);
  });

  bot.launch()
    .then(() => console.log('🤖 Bot Telegram đã khởi chạy thành công!'))
    .catch(err => console.error('Lỗi khởi chạy Bot:', err));
}

// --- API HTTP & SOCKET.IO ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  // Gửi thông tin trạng thái ban đầu cho người dùng mới kết nối
  socket.emit('stateUpdate', { isFormOpen, songs, lastWinner });
});

app.post('/api/submit', (req, res) => {
  if (!isFormOpen) {
    return res.json({ success: false, message: 'Form đã đóng, không thể gửi bài!' });
  }
  const { url, user } = req.body;
  if (!url) {
    return res.json({ success: false, message: 'Vui lòng nhập link bài hát!' });
  }

  songs.push({ url, user: user || 'Người dùng' });
  broadcastState();
  res.json({ success: true });
});

app.post('/api/spin', (req, res) => {
  const result = performSpin();
  res.json(result);
});

app.post('/api/toggle-form', (req, res) => {
  isFormOpen = !isFormOpen;
  broadcastState();
  res.json({ success: true });
});

app.post('/api/reset', (req, res) => {
  songs = [];
  lastWinner = null;
  broadcastState();
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
