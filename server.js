const express = require('express');
const { Telegraf } = require('telegraf');
const path = require('path');

// 1. Khởi tạo Express App trước
const app = express();

// 2. Cấu hình Middleware và Static Files
const publicPath = path.join(__dirname, 'public');
app.use(express.json());
app.use(express.static(publicPath));

// Route trang chủ bắt lỗi hiển thị file index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'), (err) => {
    if (err) {
      console.error("Lỗi tìm file:", err);
      res.status(404).send("Lỗi: Không tìm thấy file index.html trong thư mục public!");
    }
  });
});

// 3. Cấu hình Telegram Bot
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEB_APP_URL = process.env.WEB_APP_URL;

if (!BOT_TOKEN) {
  console.error("❌ LỖI: Chưa cấu hình BOT_TOKEN trong Environment Variables!");
}

const bot = new Telegraf(BOT_TOKEN);

let gameState = {
  isLocked: false,
  songs: []
};

bot.command('musicgame', (ctx) => {
  ctx.reply('🎪 Nhấn vào nút dưới đây để tham gia gửi link nhạc hoặc mở Vòng Quay!', {
    reply_markup: {
      inline_keyboard: [[
        { text: "🎵 Mở Game Nhạc", web_app: { url: WEB_APP_URL } }
      ]]
    }
  }).catch(err => console.error('❌ Lỗi gửi tin nhắn:', err));
});

// 4. Các API xử lý Game
app.get('/api/game', (req, res) => {
  res.json(gameState);
});

app.post('/api/submit', (req, res) => {
  if (gameState.isLocked) {
    return res.status(400).json({ error: 'Form đã đóng, không thể gửi thêm bài!' });
  }
  const { user, links } = req.body;
  if (Array.isArray(links)) {
    links.forEach(url => {
      if (url && url.trim() !== '') {
        gameState.songs.push({
          id: Date.now() + Math.random().toString(36).substr(2, 4),
          user: user || 'Ẩn danh',
          url: url.trim()
        });
      }
    });
  }
  res.json({ success: true, total: gameState.songs.length });
});

app.post('/api/lock', (req, res) => {
  gameState.isLocked = true;
  res.json({ success: true, isLocked: true });
});

app.post('/api/remove', (req, res) => {
  const { id } = req.body;
  gameState.songs = gameState.songs.filter(song => song.id !== id);
  res.json({ success: true, remaining: gameState.songs });
});

app.post('/api/reset', (req, res) => {
  gameState = { isLocked: false, songs: [] };
  res.json({ success: true });
});

// API Mở lại Form cho phép gửi bài tiếp
app.post('/api/unlock', (req, res) => {
  gameState.isLocked = false;
  res.json({ success: true, isLocked: false });
});

// 5. Khởi chạy Bot và Server
bot.launch()
  .then(() => console.log('✅ Telegram Bot đã kết nối thành công!'))
  .catch((err) => console.error('❌ Lỗi kết nối Telegram Bot:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server đang chạy trên cổng ${PORT}`));