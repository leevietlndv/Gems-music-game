const express = require('express');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');

const app = express();
const PORT = process.env.PORT || 10000;

// 1. Phục vụ các file tĩnh trong thư mục public (CSS, JS, index.html)
app.use(express.static(path.join(__dirname, 'public')));

// Route trang chủ
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2. Khởi tạo Telegram Bot (Tự động loại bỏ khoảng trắng dư thừa)
const botToken = process.env.BOT_TOKEN ? process.env.BOT_TOKEN.trim() : '';
const bot = new Telegraf(botToken);

// Middleware ghi log theo dõi tin nhắn gửi đến
bot.use(async (ctx, next) => {
  if (ctx.message && ctx.message.text) {
    console.log(`📩 Nhận tin nhắn từ [${ctx.chat.type}] (ID: ${ctx.chat.id}): ${ctx.message.text}`);
  }
  return next();
});

// 3. Hàm xử lý gửi nút bấm Mở Mini App
const handleMusicGameCommand = async (ctx) => {
  try {
    console.log('✅ Đã kích hoạt lệnh Mở Game Nhạc!');

    // Lấy URL và làm sạch ký tự xuống dòng / khoảng trắng dư thừa
    const rawUrl = process.env.WEB_APP_URL || 'https://gems-music-game.onrender.com';
    const webAppUrl = rawUrl.trim();

    // Gửi tin nhắn kèm nút bấm Web App chuẩn cú pháp Telegraf Markup
    await ctx.reply(
      '🎶 Nhấn vào nút dưới đây để tham gia gửi link nhạc hoặc mở Vòng Quay!',
      Markup.inlineKeyboard([
        [Markup.button.webApp('🎮 Mở Game Nhạc', webAppUrl)]
      ])
    );
  } catch (err) {
    console.error('❌ Lỗi gửi tin nhắn:', err);
  }
};

// Đăng ký nhận cả 3 lệnh: /start, /musicgame và /music
bot.command('start', handleMusicGameCommand);
bot.command(['musicgame', 'music'], handleMusicGameCommand);

// 4. Khởi chạy Express Web Server
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy trên cổng ${PORT}`);
});

// 5. Khởi chạy Telegram Bot an toàn (Xóa Webhook cũ để tránh kẹt)
async function startTelegramBot() {
  try {
    console.log('🔍 Đang kiểm tra và kết nối Bot...');

    if (!botToken) {
      console.error('❌ LỖI: Chưa cấu hình BOT_TOKEN trên Render Environment!');
      return;
    }

    // Xóa Webhook kẹt cũ trên máy chủ Telegram
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    console.log('🧹 Đã xóa Webhook cũ thành công!');

    // Xác thực thông tin Bot
    const botInfo = await bot.telegram.getMe();
    console.log(`🤖 Xác thực thành công Bot: @${botInfo.username}`);

    // Kích hoạt Long Polling
    bot.launch();
    console.log('✅ Telegram Bot đã chính thức lắng nghe tin nhắn!');
  } catch (err) {
    console.error('❌ Lỗi khởi chạy Telegram Bot:', err.message || err);
  }
}

startTelegramBot();

// Tự động đóng bot khi ngắt server
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
