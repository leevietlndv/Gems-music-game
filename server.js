require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});
async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS songs (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL,
    title TEXT,
    user_name TEXT NOT NULL,
    telegram_id TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
  `);

  await pool.query(`
  ALTER TABLE songs
  ADD COLUMN IF NOT EXISTS title TEXT
`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS song_votes (
      song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      telegram_id TEXT NOT NULL,
      vote SMALLINT NOT NULL CHECK (vote IN (-1, 1)),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (song_id, telegram_id)
    )
  `);

  // Phiên bản vote mới: LIKE = +1, DISLIKE = -1.
  // Bản health-v1 cũ dùng ngược dấu, nên chỉ đảo dấu đúng một lần.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS song_votes_meta (
      key TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    )
  `);

  const voteVersion = await pool.query(
    `SELECT version FROM song_votes_meta WHERE key = 'vote_semantics'`
  );

  if (voteVersion.rowCount === 0) {
    await pool.query('UPDATE song_votes SET vote = -vote');
    await pool.query(`
      INSERT INTO song_votes_meta (key, version)
      VALUES ('vote_semantics', 2)
    `);
    console.log('🔄 Đã chuyển vote sang quy ước mới: Like +1 | Dislike -1');
  }

  console.log('🗄️ PostgreSQL: Database ready');
}

async function loadSongsFromDatabase() {
  const result = await pool.query(`
    SELECT
      id,
      url,
      title,
      user_name AS user,
      telegram_id AS "telegramId",
      created_at
    FROM songs
    ORDER BY id ASC
  `);

  songs = result.rows;

  console.log(`🎵 Đã tải ${songs.length} bài hát từ PostgreSQL`);
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://gems-music-game.onrender.com';
const MAIN_MINI_APP_URL = 'https://t.me/GU3B_Radio_Bot/music3B';

const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
);

const bot = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null;

function isAdmin(telegramId) {
  if (telegramId === null || telegramId === undefined) {
    return false;
  }

  return ADMIN_IDS.has(String(telegramId));
}

function validateTelegramInitData(initData) {
  if (!initData || !BOT_TOKEN) {
    return {
      valid: false,
      message: 'Thiếu Telegram initData hoặc BOT_TOKEN'
    };
  }

  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');

    if (!receivedHash) {
      return {
        valid: false,
        message: 'Không có hash'
      };
    }

    params.delete('hash');

    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    const calculated = Buffer.from(calculatedHash, 'hex');
    const received = Buffer.from(receivedHash, 'hex');

    if (calculated.length !== received.length || !crypto.timingSafeEqual(calculated, received)) {
      return {
        valid: false,
        message: 'Chữ ký Telegram không hợp lệ'
      };
    }

    const authDate = Number(params.get('auth_date'));

    if (!authDate) {
      return {
        valid: false,
        message: 'Thiếu auth_date'
      };
    }

    const maxAge = 24 * 60 * 60;
    const now = Math.floor(Date.now() / 1000);

    if (now - authDate > maxAge) {
      return {
        valid: false,
        message: 'Telegram initData đã hết hạn'
      };
    }

    const userRaw = params.get('user');

    if (!userRaw) {
      return {
        valid: false,
        message: 'Không có thông tin user'
      };
    }

    const user = JSON.parse(userRaw);

    if (!user.id) {
      return {
        valid: false,
        message: 'Không xác định được Telegram user ID'
      };
    }

    return {
      valid: true,
      user
    };

  } catch (error) {
    console.error('Lỗi xác thực Telegram initData:', error);

    return {
      valid: false,
      message: 'initData không hợp lệ'
    };
  }
}

let isFormOpen = true;
let songs = [];
let lastWinner = null;
let lastAction = null;
let currentHealth = 5;
let currentLikeCount = 0;
let currentDislikeCount = 0;
let replacementCountdown = null;
let replacementTimer = null;
let replacementInProgress = false;

// Khóa xử lý vote để các lượt bấm đồng thời được xử lý tuần tự.
let voteQueue = Promise.resolve();

function clampHealth(value) {
  return Math.max(0, Math.min(5, Number(value) || 0));
}

async function getSongVoteStats(songId) {
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE vote = 1) AS likes,
      COUNT(*) FILTER (WHERE vote = -1) AS dislikes,
      COALESCE(SUM(vote), 0) AS score
    FROM song_votes
    WHERE song_id = $1
  `, [songId]);

  const row = result.rows[0] || {};
  const likes = Number(row.likes) || 0;
  const dislikes = Number(row.dislikes) || 0;
  const score = Number(row.score) || 0;

  return {
    likes,
    dislikes,
    score,
    health: clampHealth(5 + score)
  };
}

async function refreshCurrentSongHealth() {
  if (!lastWinner) {
    currentHealth = 5;
    currentLikeCount = 0;
    currentDislikeCount = 0;
    return { likes: 0, dislikes: 0, score: 0, health: 5 };
  }

  const stats = await getSongVoteStats(lastWinner.id);
  currentHealth = stats.health;
  currentLikeCount = stats.likes;
  currentDislikeCount = stats.dislikes;
  return stats;
}

async function getUserVote(songId, telegramId) {
  const result = await pool.query(`
    SELECT vote FROM song_votes
    WHERE song_id = $1 AND telegram_id = $2
  `, [songId, String(telegramId)]);
  return result.rowCount ? Number(result.rows[0].vote) : 0;
}

async function broadcastHealthOnly(userVote = null) {
  io.emit('songHealth', {
    songId: lastWinner?.id || null,
    health: currentHealth,
    likes: currentLikeCount,
    dislikes: currentDislikeCount,
    replacementCountdown,
    ...(userVote === null ? {} : { userVote })
  });
}

function clearReplacementCountdown() {
  if (replacementTimer) {
    clearInterval(replacementTimer);
    replacementTimer = null;
  }
  replacementCountdown = null;
}

function broadcastReplacementCountdown() {
  io.emit('replacementCountdown', {
    songId: lastWinner?.id || null,
    countdown: replacementCountdown
  });
}

async function replaceCurrentSongDueToHealth() {
  if (replacementInProgress || !lastWinner || currentHealth !== 0) return false;

  replacementInProgress = true;
  try {
    const previousSong = lastWinner;
    const previousTitle = previousSong.title || previousSong.url || 'bài hát trước đó';
    const availableSongs = songs.filter(song => String(song.id) !== String(previousSong.id));

    clearReplacementCountdown();

    if (availableSongs.length === 0) {
      currentHealth = 0;
      await broadcastHealthOnly();
      return false;
    }

    const nextSong = availableSongs[Math.floor(Math.random() * availableSongs.length)];

    await pool.query('DELETE FROM song_votes WHERE song_id = $1', [previousSong.id]);
    await pool.query('DELETE FROM songs WHERE id = $1', [previousSong.id]);
    songs = songs.filter(song => String(song.id) !== String(previousSong.id));

    lastWinner = nextSong;
    currentHealth = 5;
    currentLikeCount = 0;
    currentDislikeCount = 0;
    lastAction = { type: 'replace', title: previousTitle };

    io.emit('songPlayed', {
      song: nextSong,
      initiatorSocketId: null,
      action: lastAction,
      health: 5,
      likes: 0,
      dislikes: 0,
      replacementCountdown: null
    });
    broadcastState();

    console.log(`❤️ Máu về 0 quá 10 giây → thay #${previousSong.id} bằng #${nextSong.id}: ${nextSong.title || nextSong.url}`);
    return true;
  } catch (error) {
    console.error('❌ Lỗi tự động thay bài do máu:', error);
    return false;
  } finally {
    replacementInProgress = false;
  }
}

function startReplacementCountdown() {
  if (replacementTimer || !lastWinner || currentHealth !== 0) return;

  replacementCountdown = 10;
  broadcastReplacementCountdown();

  replacementTimer = setInterval(async () => {
    if (!lastWinner || currentHealth !== 0) {
      clearReplacementCountdown();
      broadcastReplacementCountdown();
      return;
    }

    replacementCountdown -= 1;

    if (replacementCountdown <= 0) {
      clearReplacementCountdown();
      const run = voteQueue.then(() => replaceCurrentSongDueToHealth(), () => replaceCurrentSongDueToHealth());
      voteQueue = run.catch(() => {});
      await run;
      return;
    }

    broadcastReplacementCountdown();
  }, 1000);
}

async function performSpin(initiatorSocketId = null, actionUser = null) {
  if (lastWinner) {
  await pool.query(
      'DELETE FROM songs WHERE id = $1',
      [lastWinner.id]
    );

    songs = songs.filter(song => String(song.id) !== String(lastWinner.id));

    lastWinner = null;
    lastAction = null;
    currentHealth = 5;
    currentLikeCount = 0;
    currentDislikeCount = 0;
    clearReplacementCountdown();
  }

  if (songs.length === 0) {
    broadcastState();
    return { success: false, message: 'Danh sách bài hát đã hết!' };
  }

  const selectedIndex = Math.floor(Math.random() * songs.length);
  const winner = songs[selectedIndex];
  lastWinner = winner;
  currentHealth = 5;
  currentLikeCount = 0;
  currentDislikeCount = 0;
  clearReplacementCountdown();
  lastAction = actionUser ? { type: 'spin', user: actionUser } : null;

  io.emit('triggerSpin', {
    selectedIndex,
    winner,
    initiatorSocketId,
    action: lastAction
  });
  broadcastState();
  return { success: true, winner };
}

  // --- CÁC LỆNH BOT TELEGRAM ---
  if (bot) {
  const sendWebAppButton = (ctx) => {
    const miniAppUrl = 'https://t.me/GU3B_Radio_Bot/music3B';

    ctx.reply(
      '🎧 Bấm vào bên dưới để gửi nhạc',
      Markup.inlineKeyboard([
        [
          Markup.button.url(
            '𝄞 Mở GEMS Radio',
            MAIN_MINI_APP_URL
          )
        ]
      ])
    );
  };

  // Nhận lệnh /start và /musicgems
  bot.command(['start', 'radio', 'music'], sendWebAppButton);

  // Inline Mode: @TênBot
  bot.on('inline_query', async (ctx) => {
    try {
      await ctx.answerInlineQuery([
        {
          type: 'article',
          id: 'gems_music_game',
          title: '𝄞 Mở GEMS Radio',
          description: 'Mở Mini App để gửi nhạc',
          input_message_content: {
            message_text: '🎧 Mở Mini App để gửi nhạc'
          },
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '𝄞 Mở GEMS Radio',
                  web_app: {
                    url: WEBAPP_URL
                  }
                }
              ]
            ]
          }
        }
      ]);
    } catch (error) {
      console.error('❌ Lỗi Inline Mode:', error);
    }
  });

  bot.command('spin', async (ctx) => {
    const result = await performSpin();
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

  bot.command('reset', async (ctx) => {
    await pool.query('DELETE FROM songs');

    songs = [];
    lastWinner = null;

    setAutoPlayState(0);
    broadcastAutoPlayState();
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

  // Tự động đăng ký Menu lệnh
  bot.telegram.setMyCommands([
    { command: 'radio', description: 'Mở Vòng Quay Nhạc' },
    { command: 'music', description: 'Mở Vòng Quay Nhạc' },
    { command: 'spin', description: 'Quay ngẫu nhiên bài hát' },
    { command: 'toggle', description: 'Bật/Tắt form gửi bài' },
    { command: 'list', description: 'Xem danh sách bài hát' },
    { command: 'reset', description: 'Xóa toàn bộ danh sách' }
  ]).catch(err => console.error('Lỗi thiết lập menu lệnh:', err));

  bot.telegram.setChatMenuButton({
    menu_button: {
      type: 'web_app',
      text: '𝄞 Mở GEMS Radio',
      web_app: { url: WEBAPP_URL }
    }
  }).then(() => console.log('📱 Menu Telegram đã trỏ tới Mini App:', WEBAPP_URL))
    .catch(err => console.error('Lỗi thiết lập Menu Mini App:', err));

  bot.launch()
    .then(() => console.log('🤖 Bot Telegram đã khởi chạy thành công!'))
    .catch(err => console.error('Lỗi khởi chạy Bot:', err));
  }
// --- API HTTP & SOCKET.IO ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


// ==================== ADMIN AUTH HELPER ====================
function requireTelegramAdmin(req, res) {
  const initData = req.body?.initData || '';
  const auth = validateTelegramInitData(initData);

  if (!auth.valid) {
    res.status(401).json({
      success: false,
      message: `Xác thực Telegram thất bại: ${auth.message}`
    });
    return { ok: false };
  }

  const telegramId = String(auth.user.id);
  if (!isAdmin(telegramId)) {
    res.status(403).json({
      success: false,
      message: 'Bạn không có quyền Admin.'
    });
    return { ok: false };
  }

  return { ok: true, user: auth.user };
}

// ==================== YOUTUBE TITLE ====================
async function getYouTubeTitle(url) {
  try {
    const oembedUrl =
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;

    const response = await fetch(oembedUrl);

    if (!response.ok) {
      console.warn(`⚠️ Không lấy được YouTube title: HTTP ${response.status}`);
      return 'Bài hát YouTube';
    }

    const data = await response.json();
    return data.title || 'Bài hát YouTube';
  } catch (error) {
    console.error('❌ Lỗi lấy YouTube title:', error);
    return 'Bài hát YouTube';
  }
}

// ==================== YOUTUBE URL VALIDATION ====================
function getYouTubeVideoId(inputUrl) {
  try {
    const url = new URL(String(inputUrl).trim());
    const hostname = url.hostname
      .toLowerCase()
      .replace(/^www\./, '');

    if (hostname === 'youtu.be') {
      return url.pathname.split('/').filter(Boolean)[0] || null;
    }

    if (
      hostname === 'youtube.com' ||
      hostname === 'm.youtube.com' ||
      hostname === 'music.youtube.com'
    ) {
      const videoId = url.searchParams.get('v');
      if (videoId) return videoId;

      const parts = url.pathname.split('/').filter(Boolean);
      if (
        parts.length >= 2 &&
        ['shorts', 'embed', 'live'].includes(parts[0])
      ) {
        return parts[1];
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}

// ==================== AUTO PLAY STATE ====================
// 0 = Tắt | 1 = Tuần tự | 2 = Ngẫu nhiên
let autoPlayMode = 0;
let autoPlayControllerSocketId = null;

function setAutoPlayState(mode, controllerSocketId = null) {
  autoPlayMode = Number(mode) || 0;
  autoPlayControllerSocketId = autoPlayMode === 0
    ? null
    : (controllerSocketId || null);
}

function broadcastAutoPlayState() {
  io.emit('autoPlayMode', {
    mode: autoPlayMode,
    controllerSocketId: autoPlayControllerSocketId
  });
}

function broadcastState() {
  io.emit('stateUpdate', {
    isFormOpen,
    songs,
    lastWinner,
    lastAction,
    health: currentHealth,
    likes: currentLikeCount,
    dislikes: currentDislikeCount,
    replacementCountdown,
    autoPlayMode,
    controllerSocketId: autoPlayControllerSocketId
  });
}


// ==================== API: SUBMIT SONG ====================
app.post('/api/submit', async (req, res) => {
  if (!isFormOpen) {
    return res.json({
      success: false,
      message: 'Form đã đóng, không thể gửi bài!'
    });
  }

  const { url, initData } = req.body;

  if (!url) {
    return res.json({
      success: false,
      message: 'Vui lòng nhập link bài hát!'
    });
  }

  const auth = validateTelegramInitData(initData);
  if (!auth.valid) {
    return res.status(401).json({
      success: false,
      message: 'Xác thực Telegram thất bại!'
    });
  }

  const telegramUser = auth.user;
  const userName =
    [telegramUser.first_name, telegramUser.last_name]
      .filter(Boolean)
      .join(' ')
      .trim() || 'Người dùng';

  const cleanUrl = String(url).trim();
  const youtubeVideoId = getYouTubeVideoId(cleanUrl);

  if (!youtubeVideoId) {
    return res.json({
      success: false,
      message: 'Link YouTube không hợp lệ!'
    });
  }

  try {
    const existingSongs = await pool.query('SELECT id, url FROM songs');
    const existingSong = existingSongs.rows.find(
      song => getYouTubeVideoId(song.url) === youtubeVideoId
    );

    if (existingSong) {
      return res.json({
        success: false,
        message: '⚠️ Bài hát này đã tồn tại trong danh sách!'
      });
    }

    const title = await getYouTubeTitle(cleanUrl);

    const result = await pool.query(
      `
        INSERT INTO songs (
          url,
          title,
          user_name,
          telegram_id
        )
        VALUES ($1, $2, $3, $4)
        RETURNING
          id,
          url,
          title,
          user_name AS user,
          telegram_id AS "telegramId",
          created_at
      `,
      [
        cleanUrl,
        title,
        userName,
        String(telegramUser.id)
      ]
    );

    songs.push(result.rows[0]);
    songs.sort((a, b) => Number(a.id) - Number(b.id));
    broadcastState();

    console.log(
      `🎵 Đã lưu bài hát #${result.rows[0].id} vào PostgreSQL: ${cleanUrl}`
    );

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Lỗi lưu bài hát vào PostgreSQL:', error);
    res.status(500).json({
      success: false,
      message: 'Không thể lưu bài hát vào cơ sở dữ liệu!'
    });
  }
});

// ==================== API: AUTO PLAY MODE ====================
app.post('/api/auto-play-mode', async (req, res) => {
  const { mode, socketId } = req.body;
  const auth = requireTelegramAdmin(req, res);
  if (!auth.ok) return;

  const newMode = Number(mode);

  if (![0, 1, 2].includes(newMode)) {
    return res.status(400).json({
      success: false,
      message: 'Chế độ Auto Play không hợp lệ!'
    });
  }

  if (newMode === 0) {
    setAutoPlayState(0);
    broadcastAutoPlayState();
    broadcastState();

    console.log('⏹ Admin đã tắt Auto Play');

    return res.json({
      success: true,
      mode: 0,
      controllerSocketId: null
    });
  }

  if (!socketId || typeof socketId !== 'string') {
    return res.status(400).json({
      success: false,
      message: 'Thiếu socketId của thiết bị điều khiển.'
    });
  }

  setAutoPlayState(newMode, socketId);
  broadcastAutoPlayState();
  broadcastState();

  console.log(
    autoPlayMode === 1
      ? `🔢 Admin bật Auto Play TUẦN TỰ | controller=${socketId}`
      : `🔀 Admin bật Auto Play NGẪU NHIÊN | controller=${socketId}`
  );

  res.json({
    success: true,
    mode: autoPlayMode,
    controllerSocketId: autoPlayControllerSocketId,
    hasCurrentSong: !!lastWinner
  });
});

// ==================== API: AUTO PLAY NEXT ====================
app.post('/api/auto-play-next', async (req, res) => {
  const { socketId, expectedSongId } = req.body;
  const auth = requireTelegramAdmin(req, res);
  if (!auth.ok) return;

  if (autoPlayMode === 0) {
    return res.json({
      success: false,
      stopAutoPlay: true,
      message: 'Auto Play đang tắt.'
    });
  }

  if (!socketId || socketId !== autoPlayControllerSocketId) {
    return res.status(403).json({
      success: false,
      message: 'Không phải thiết bị Admin đang điều khiển Auto Play.'
    });
  }

  try {
    const currentId = lastWinner?.id != null
      ? String(lastWinner.id)
      : null;

    // Bảo vệ khỏi race-condition: nếu một lệnh Auto Play cũ vừa gửi
    // sau khi Admin/user đã bấm Play hoặc Spin, không được phép ghi đè
    // bài mới. Client phải xác nhận đúng bài vừa kết thúc.
    if (expectedSongId != null && currentId !== String(expectedSongId)) {
      return res.json({
        success: false,
        stale: true,
        message: 'Bỏ qua Auto Play cũ vì bài đang phát đã thay đổi.'
      });
    }

    const availableSongs = songs.filter(song =>
      !currentId || String(song.id) !== currentId
    );

    if (availableSongs.length === 0) {
      setAutoPlayState(0);
      broadcastAutoPlayState();
      broadcastState();

      console.log('⏹ Auto Play dừng: không còn bài tiếp theo.');

      return res.json({
        success: false,
        stopAutoPlay: true,
        message: 'Không còn bài hát tiếp theo.'
      });
    }

    let nextSong;

    if (autoPlayMode === 1) {
      // Tuần tự: songs được giữ theo id ASC, nên lấy bài đầu tiên còn lại.
      nextSong = availableSongs[0];
    } else {
      const randomIndex = Math.floor(Math.random() * availableSongs.length);
      nextSong = availableSongs[randomIndex];
    }

    if (!nextSong) {
      return res.status(500).json({
        success: false,
        message: 'Không tìm được bài hát tiếp theo.'
      });
    }

    if (lastWinner && String(lastWinner.id) !== String(nextSong.id)) {
      await pool.query('DELETE FROM songs WHERE id = $1', [lastWinner.id]);
      songs = songs.filter(song => String(song.id) !== String(lastWinner.id));
      console.log(`🗑️ Auto Play xóa bài cũ #${lastWinner.id}`);
    }

    lastWinner = nextSong;
    currentHealth = 5;
    currentLikeCount = 0;
    currentDislikeCount = 0;
    lastAction = null;
    clearReplacementCountdown();

    io.emit('songPlayed', {
      song: nextSong,
      initiatorSocketId: autoPlayControllerSocketId,
      action: null,
      health: 5,
      likes: 0,
      dislikes: 0,
      replacementCountdown: null
    });

    broadcastState();

    console.log(
      autoPlayMode === 1
        ? `🔢 Auto tuần tự → #${nextSong.id}`
        : `🔀 Auto ngẫu nhiên → #${nextSong.id}`
    );

    res.json({
      success: true,
      song: nextSong,
      mode: autoPlayMode
    });
  } catch (error) {
    console.error('❌ Lỗi Auto Play Next:', error);
    res.status(500).json({
      success: false,
      message: 'Không thể phát bài tiếp theo.'
    });
  }
});

// ==================== API: PLAY ONE SONG ====================
// Tất cả user đều được phép phát.
// Người bấm Play nghe tiếng; các client khác phát mute.
app.post('/api/play-song', async (req, res) => {
  const { id, initData, socketId } = req.body;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: 'Thiếu ID bài hát!'
    });
  }

  const auth = validateTelegramInitData(initData);
  if (!auth.valid) {
    return res.status(401).json({
      success: false,
      message: `Xác thực Telegram thất bại: ${auth.message}`
    });
  }

  try {
    const result = await pool.query(`
      SELECT
        id,
        url,
        title,
        user_name AS user,
        telegram_id AS "telegramId",
        created_at
      FROM songs
      WHERE id = $1
    `, [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy bài hát!'
      });
    }

    const song = result.rows[0];

    if (lastWinner && String(lastWinner.id) !== String(song.id)) {
      await pool.query('DELETE FROM songs WHERE id = $1', [lastWinner.id]);
      songs = songs.filter(s => String(s.id) !== String(lastWinner.id));
      console.log(`🗑️ Đã xóa bài đang phát #${lastWinner.id}`);
    }

    lastWinner = song;
    currentHealth = 5;
    currentLikeCount = 0;
    currentDislikeCount = 0;
    clearReplacementCountdown();

    const userName =
      [auth.user.first_name, auth.user.last_name]
        .filter(Boolean)
        .join(' ')
        .trim() || 'Người dùng';

    lastAction = { type: 'play', user: userName };

    // Nếu Admin đang bật Auto Play thì vẫn giữ mode,
    // nhưng bài Play thủ công thay thế bài đang phát hiện tại.
    io.emit('songPlayed', {
      song,
      initiatorSocketId: socketId || null,
      action: lastAction,
      health: 5,
      likes: 0,
      dislikes: 0,
      replacementCountdown: null
    });

    broadcastState();

    console.log(`▶️ Phát bài hát #${song.id}: ${song.title || song.url}`);

    res.json({
      success: true,
      song
    });
  } catch (error) {
    console.error('❌ Lỗi phát bài hát:', error);
    res.status(500).json({
      success: false,
      message: 'Không thể phát bài hát!'
    });
  }
});

// ==================== API: SONG HEALTH / LIKE / DISLIKE ====================
app.post('/api/song-vote', async (req, res) => {
  const { vote } = req.body || {};
  const auth = validateTelegramInitData(req.body?.initData || '');

  if (!auth.valid) {
    return res.status(401).json({
      success: false,
      message: `Xác thực Telegram thất bại: ${auth.message}`
    });
  }

  const requestedVote = Number(vote);
  if (![1, -1].includes(requestedVote)) {
    return res.status(400).json({
      success: false,
      message: 'Loại vote không hợp lệ!'
    });
  }

  const runVote = async () => {
    if (!lastWinner) {
      return {
        success: false,
        status: 400,
        message: 'Hiện chưa có bài hát đang phát.'
      };
    }

    const songId = lastWinner.id;
    const telegramId = String(auth.user.id);
    const previousVote = await getUserVote(songId, telegramId);
    let newVote = requestedVote;

    // LIKE = +1 | DISLIKE = -1.
    // Mỗi Telegram user chỉ có một vote cho bài hiện tại.
    // Bấm lại cùng nút = bỏ vote; bấm nút đối diện = đổi vote.
    if (previousVote === requestedVote) {
      await pool.query(
        'DELETE FROM song_votes WHERE song_id = $1 AND telegram_id = $2',
        [songId, telegramId]
      );
      newVote = 0;
    } else {
      await pool.query(`
        INSERT INTO song_votes (song_id, telegram_id, vote)
        VALUES ($1, $2, $3)
        ON CONFLICT (song_id, telegram_id)
        DO UPDATE SET vote = EXCLUDED.vote
      `, [songId, telegramId, requestedVote]);
    }

    const stats = await refreshCurrentSongHealth();

    // Máu trở lại trên 0 → hủy đếm ngược thay bài.
    if (currentHealth > 0) {
      if (replacementTimer) {
        clearReplacementCountdown();
        broadcastReplacementCountdown();
      }
    }

    // Máu chạm 0 → bắt đầu đếm ngược 10 giây.
    if (currentHealth === 0) {
      startReplacementCountdown();
    }

    await broadcastHealthOnly(newVote);
    broadcastState();

    return {
      success: true,
      replaced: false,
      health: currentHealth,
      likes: currentLikeCount,
      dislikes: currentDislikeCount,
      replacementCountdown,
      userVote: newVote
    };
  };

  const run = voteQueue.then(runVote, runVote);
  voteQueue = run.catch(() => {});
  const result = await run;

  if (result.status) return res.status(result.status).json(result);
  return res.json(result);
});

// ==================== API: SPIN ====================
app.post('/api/spin', async (req, res) => {
  const auth = requireTelegramAdmin(req, res);
  if (!auth.ok) return;

  const { socketId } = req.body || {};
  const userName =
    [auth.user.first_name, auth.user.last_name]
      .filter(Boolean)
      .join(' ')
      .trim() || 'Người dùng';

  try {
    const result = await performSpin(socketId || null, userName);
    res.json(result);
  } catch (error) {
    console.error('❌ Lỗi Spin:', error);
    res.status(500).json({
      success: false,
      message: 'Không thể quay vòng quay!'
    });
  }
});

// ==================== API: TOGGLE FORM ====================
app.post('/api/toggle-form', (req, res) => {
  const auth = requireTelegramAdmin(req, res);
  if (!auth.ok) return;

  isFormOpen = !isFormOpen;
  broadcastState();
  res.json({ success: true, isFormOpen });
});

// ==================== API: RESET ====================
app.post('/api/reset', async (req, res) => {
  const auth = requireTelegramAdmin(req, res);
  if (!auth.ok) return;

  try {
    await pool.query('DELETE FROM songs');

    songs = [];
    lastWinner = null;
    lastAction = null;
    currentHealth = 5;
    currentLikeCount = 0;
    currentDislikeCount = 0;
    clearReplacementCountdown();

    // Reset cũng tắt Auto Play để không tự phát lại sau khi reset.
    setAutoPlayState(0);
    broadcastAutoPlayState();
    broadcastState();

    console.log('🧹 Đã xóa toàn bộ bài hát khỏi PostgreSQL');

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Lỗi reset PostgreSQL:', error);
    res.status(500).json({
      success: false,
      message: 'Không thể xóa danh sách bài hát!'
    });
  }
});

// ==================== API: DELETE ONE SONG ====================
app.post('/api/delete-song', async (req, res) => {
  const auth = requireTelegramAdmin(req, res);
  if (!auth.ok) return;

  const { id } = req.body;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: 'Thiếu ID bài hát!'
    });
  }

  try {
    const result = await pool.query(
      'DELETE FROM songs WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy bài hát!'
      });
    }

    songs = songs.filter(song => String(song.id) !== String(id));

    // Nếu xóa chính bài đang phát, xóa luôn trạng thái current winner.
    if (lastWinner && String(lastWinner.id) === String(id)) {
      lastWinner = null;
      lastAction = null;
      currentHealth = 5;
      currentLikeCount = 0;
      currentDislikeCount = 0;
      clearReplacementCountdown();
    }

    broadcastState();

    console.log(`🗑️ Admin đã xóa bài hát #${id}`);

    res.json({
      success: true,
      message: 'Đã xóa bài hát!'
    });
  } catch (error) {
    console.error('❌ Lỗi xóa bài hát:', error);
    res.status(500).json({
      success: false,
      message: 'Không thể xóa bài hát!'
    });
  }
});


// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
  console.log(`🔌 Socket connected: ${socket.id}`);

  socket.emit('stateUpdate', {
    isFormOpen,
    songs,
    lastWinner,
    lastAction,
    health: currentHealth,
    autoPlayMode,
    controllerSocketId: autoPlayControllerSocketId
  });

  socket.emit('autoPlayMode', {
    mode: autoPlayMode,
    controllerSocketId: autoPlayControllerSocketId
  });

  socket.on('authenticate', (payload = {}) => {
    const initData = payload.initData || '';
    console.log(
      `🔑 Authenticate received: socket=${socket.id}, initDataLength=${initData.length}`
    );

    const auth = validateTelegramInitData(initData);

    if (!auth.valid) {
      console.log('❌ Telegram authentication failed:', auth.message);
      socket.emit('adminStatus', {
        isAdmin: false,
        authenticated: false,
        message: auth.message
      });
      return;
    }

    const telegramId = String(auth.user.id);
    const admin = isAdmin(telegramId);

    console.log(`🔐 Telegram ID: ${telegramId} | Admin: ${admin}`);

    socket.emit('adminStatus', {
      isAdmin: admin,
      authenticated: true,
      telegramId
    });

    (async () => {
      if (!lastWinner) {
        socket.emit('songHealth', { songId: null, health: 5, likes: 0, dislikes: 0, replacementCountdown: null, userVote: 0 });
        return;
      }
      try {
        const userVote = await getUserVote(lastWinner.id, telegramId);
        socket.emit('songHealth', {
          songId: lastWinner.id,
          health: currentHealth,
          likes: currentLikeCount,
          dislikes: currentDislikeCount,
          replacementCountdown,
          userVote
        });
      } catch (error) {
        console.error('❌ Lỗi lấy vote hiện tại:', error);
      }
    })();
  });

  socket.on('disconnect', (reason) => {
    console.log(`🔌 Socket disconnected: ${socket.id} | ${reason}`);

    if (socket.id === autoPlayControllerSocketId) {
      setAutoPlayState(0);
      broadcastAutoPlayState();
      broadcastState();

      console.log('⏹ Auto Play tự tắt vì Admin điều khiển đã thoát.');
    }
  });
});


const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await initDatabase();
    await loadSongsFromDatabase();

    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🎵 Songs loaded: ${songs.length}`);
    });
  } catch (error) {
    console.error('❌ Không thể khởi động server:', error);
    process.exit(1);
  }
}

startServer();
