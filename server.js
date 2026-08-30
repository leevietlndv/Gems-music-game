const express = require('express');
const { Telegraf } = require('telegraf');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Lấy Token và URL từ Biến môi trường
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEB_APP_URL = process.env.WEB_APP_URL;

const bot = new Telegraf(BOT_TOKEN);

let gameState = { isLocked: false, songs: [] };

// Lệnh gửi nút mở App
bot.command('musicgame', (ctx) => {
  ctx.reply('🎪 Nhấn vào nút dưới đây để tham gia gửi link nhạc hoặc mở Vòng Quay!', {
    reply_markup: {
      inline_keyboard: [[
        { text: "🎵 Mở Game Nhạc", web_app: { url: WEB_APP_URL } }
      ]]
    }
  });
});

// Các API khôi phục giữ nguyên như cũ...
app.get('/api/game', (req, res) => res.json(gameState));
app.post('/api/submit', (req, res) => { /* ...code cũ... */ });
app.post('/api/lock', (req, res) => { /* ...code cũ... */ });
app.post('/api/remove', (req, res) => { /* ...code cũ... */ });

// Kích hoạt Bot & Server
bot.launch();

// Render sẽ tự cấp cổng qua process.env.PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server đang chạy trên cổng ${PORT}`));

// Lệnh bot gửi nút mở Mini App vào nhóm chat
bot.command('musicgame', (ctx) => {
  ctx.reply('🎪 Nhấn vào nút dưới đây để tham gia gửi link nhạc hoặc mở Vòng Quay!', {
    reply_markup: {
      inline_keyboard: [[
        { text: "🎵 Mở Game Nhạc", web_app: { url: "https://your-domain.vercel.app" } }
      ]]
    }
  });
});

// API Lấy trạng thái & danh sách bài hát
app.get('/api/game', (req, res) => {
  res.json(gameState);
});

// API Thành viên gửi link bài hát
app.post('/api/submit', (req, res) => {
  if (gameState.isLocked) {
    return res.status(400).json({ error: 'Form đã đóng, không thể gửi thêm bài!' });
  }
  const { user, links } = req.body;
  
  links.forEach(url => {
    if (url && url.trim() !== '') {
      gameState.songs.push({
        id: Date.now() + Math.random().toString(36).substr(2, 4),
        user: user || 'Ẩn danh',
        url: url.trim()
      });
    }
  });
  res.json({ success: true, total: gameState.songs.length });
});

// API Người mở nhạc đóng Form
app.post('/api/lock', (req, res) => {
  gameState.isLocked = true;
  res.json({ success: true, isLocked: true });
});

// API Xóa bài hát sau khi phát xong
app.post('/api/remove', (req, res) => {
  const { id } = req.body;
  gameState.songs = gameState.songs.filter(song => song.id !== id);
  res.json({ success: true, remaining: gameState.songs });
});

// Reset trò chơi mới
app.post('/api/reset', (req, res) => {
  gameState = { isLocked: false, songs: [] };
  res.json({ success: true });
});

// Kiểm tra biến môi trường trước khi chạy
if (!process.env.BOT_TOKEN) {
  console.error("❌ LỖI: Chưa cấu hình BOT_TOKEN trong Environment Variables!");
}

// Khởi chạy Bot có bắt lỗi
bot.launch()
  .then(() => console.log('✅ Telegram Bot đã kết nối thành công!'))
  .catch((err) => console.error('❌ Lỗi kết nối Telegram Bot:', err));

// Cho phép dừng bot an toàn khi server restart
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server đang chạy trên cổng ${PORT}`));

bot.launch();
app.listen(3000, () => console.log('Server running on port 3000'));