const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const { Telegraf, Markup } = require('telegraf');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

let gameState = {
  isFormOpen: true,
  songs: []
};

// Đồng bộ qua Socket.io khi có kết nối mới
io.on('connection', (socket) => {
  socket.emit('stateUpdate', gameState);
});

// Hàm phát thông báo tới tất cả client
const broadcastState = () => {
  io.emit('stateUpdate', gameState);
};

// --- API ENDPOINTS ---
app.get('/api/state', (req, res) => res.json({ success: true, ...gameState }));

app.post('/api/submit', (req, res) => {
  if (!gameState.isFormOpen) return res.status(400).json({ success: false, message: 'Form đang đóng!' });
  const songUrl = req.body.url;
  const userName = req.body.user || 'Người dùng';

  if (!songUrl) return res.status(400).json({ success: false, message: 'URL không hợp lệ!' });

  const newSong = { id: Date.now().toString(), url: songUrl.trim(), user: userName };
  gameState.songs.push(newSong);

  broadcastState(); // 🚀 Báo cho tất cả thiết bị
  res.json({ success: true, song: newSong, songs: gameState.songs });
});

app.post('/api/spin', (req, res) => {
  if (gameState.songs.length === 0) return res.status(400).json({ success: false, message: 'Danh sách trống!' });
  const selectedIndex = Math.floor(Math.random() * gameState.songs.length);
  const winner = gameState.songs[selectedIndex];

  // 🚀 Phát lệnh quay vòng quay đồng bộ tới TẤT CẢ mọi người
  io.emit('triggerSpin', { selectedIndex, winner });

  res.json({ success: true, selectedIndex, winner });
});

app.post('/api/toggle-form', (req, res) => {
  gameState.isFormOpen = !gameState.isFormOpen;
  broadcastState(); // 🚀 Báo cho tất cả thiết bị
  res.json({ success: true, isFormOpen: gameState.isFormOpen });
});

app.post('/api/reset', (req, res) => {
  gameState.songs = [];
  gameState.isFormOpen = true;
  broadcastState(); // 🚀 Báo cho tất cả thiết bị
  res.json({ success: true, isFormOpen: gameState.isFormOpen, songs: [] });
});

// --- TELEGRAM BOT ---
const botToken = process.env.BOT_TOKEN ? process.env.BOT_TOKEN.trim() : '';
const bot = new Telegraf(botToken);

const handleMusicGameCommand = async (ctx) => {
  const rawUrl = process.env.WEB_APP_URL || 'https://gems-music-game.onrender.com';
  await ctx.reply(
    '🎶 Nhấn vào nút dưới đây để tham gia gửi link nhạc hoặc mở Vòng Quay!',
    Markup.inlineKeyboard([[Markup.button.webApp('🎮 Mở Game Nhạc', rawUrl.trim())]])
  );
};

bot.command('start', handleMusicGameCommand);
bot.hears(/^\/(musicgame|music)/i, handleMusicGameCommand);

// Lắng nghe cổng từ HTTP Server (bao gồm Socket.io)
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

async function startTelegramBot() {
  if (!botToken) return;
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  bot.botInfo = await bot.telegram.getMe();
  bot.launch();
}
startTelegramBot();
