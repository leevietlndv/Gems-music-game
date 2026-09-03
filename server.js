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

// ==================== AUTHORITATIVE PLAYBACK TIMELINE ====================
// Server giữ trạng thái phát/tạm dừng và một mốc thời gian chung.
// Client mới sẽ seek tới vị trí này; authority gửi vị trí thực tế định kỳ.
let playbackState = {
  songId: null,
  status: 'stopped',
  position: 0,
  serverTime: Date.now(),
  version: 0,
  authoritySocketId: null,
  startAt: null,
  controlLockUntil: 0,
  controlLockSocketId: null
};
let playbackControlQueue = Promise.resolve();
let playbackSeekLock = { active: false, socketId: null, until: 0, token: 0 };
let playbackSeekReleaseTimer = null;
let playbackSeekSuppressAuthorityUntil = 0;

// ==================== GLOBAL SONG ACTION LOCK ====================
// Mọi thao tác làm thay đổi bài đang phát phải đi qua cùng một lock:
// Spin / Play / Auto Play Next / Health Replace.
// Lock nằm ở server để nhiều Admin/user trên nhiều thiết bị không thể
// cùng lúc ghi đè lastWinner và timeline.
let songActionQueue = Promise.resolve();
let songActionVersion = 0;
let songActionLock = {
  active: false,
  type: null,
  socketId: null,
  until: 0,
  version: 0
};
let songActionReleaseTimer = null;

function getSongActionPayload() {
  const now = Date.now();
  if (songActionLock.active && songActionLock.until <= now) {
    songActionLock = { active: false, type: null, socketId: null, until: 0, version: songActionLock.version };
  }

  return {
    active: songActionLock.active,
    type: songActionLock.type,
    until: songActionLock.until,
    version: songActionLock.version
  };
}

function broadcastSongActionState() {
  io.emit('songActionLock', getSongActionPayload());
}

function releaseSongActionLock(version) {
  if (songActionLock.version !== version) return;

  songActionLock = {
    active: false,
    type: null,
    socketId: null,
    until: 0,
    version
  };

  if (songActionReleaseTimer) {
    clearTimeout(songActionReleaseTimer);
    songActionReleaseTimer = null;
  }

  broadcastSongActionState();
}

function runSongAction(type, socketId, lockMs, handler) {
  const run = songActionQueue.then(async () => {
    const now = Date.now();

    if (songActionLock.active && songActionLock.until > now) {
      return {
        success: false,
        status: 409,
        message: `Đang xử lý thao tác ${songActionLock.type || 'khác'}. Vui lòng chờ thao tác hoàn tất.`,
        songActionLock: getSongActionPayload()
      };
    }

    songActionVersion += 1;
    const version = songActionVersion;

    songActionLock = {
      active: true,
      type,
      socketId: socketId || null,
      until: now + lockMs,
      version
    };

    broadcastSongActionState();

    try {
      return await handler(version);
    } finally {
      if (songActionLock.version === version) {
        songActionReleaseTimer = setTimeout(() => {
          releaseSongActionLock(version);
        }, Math.max(0, lockMs));
      }
    }
  });

  songActionQueue = run.catch(() => {});
  return run;
}

let currentHealth = 5;
let currentLikeCount = 0;
let currentDislikeCount = 0;
let replacementCountdown = null;
let replacementTimer = null;
let replacementInProgress = false;

// ==================== ONLINE USERS / CONNECTIONS ====================
// Đếm user Telegram duy nhất, đồng thời theo dõi số socket đang kết nối.
// Một Telegram user mở nhiều thiết bị vẫn chỉ tính là 1 user online.
const onlineUsers = new Map();
const socketPresence = new Map();
const socketAuth = new Map();

function detectDeviceType(deviceInfo = {}) {
  const platform = String(deviceInfo.platform || '').toLowerCase();
  const userAgent = String(deviceInfo.userAgent || '').toLowerCase();

  // Tablet: iPad hoặc Android không có chuỗi "mobile".
  if (
    userAgent.includes('ipad') ||
    platform === 'ipad' ||
    (userAgent.includes('android') && !userAgent.includes('mobile'))
  ) {
    return 'tablet';
  }

  // Máy tính: Telegram Desktop hoặc trình duyệt desktop.
  if (
    ['tdesktop', 'macos', 'windows', 'linux'].includes(platform) ||
    userAgent.includes('windows nt') ||
    userAgent.includes('macintosh') ||
    userAgent.includes('x11') ||
    (userAgent.includes('linux') && !userAgent.includes('android'))
  ) {
    return 'computer';
  }

  // Còn lại ưu tiên coi là điện thoại.
  return 'phone';
}

function addOnlineUser(socket, authUser, deviceInfo = {}) {
  const telegramId = String(authUser.id);
  const userName =
    [authUser.first_name, authUser.last_name]
      .filter(Boolean)
      .join(' ')
      .trim() ||
    authUser.username ||
    'Người dùng';

  // Nếu socket này từng đăng nhập user khác, gỡ presence cũ trước.
  removeOnlineUser(socket.id, false);

  let entry = onlineUsers.get(telegramId);
  if (!entry) {
    entry = {
      telegramId,
      name: userName,
      connections: new Map()
    };
    onlineUsers.set(telegramId, entry);
  } else {
    entry.name = userName;
  }

  entry.connections.set(socket.id, {
    device: detectDeviceType(deviceInfo)
  });

  socketPresence.set(socket.id, telegramId);
  socketAuth.set(socket.id, {
    telegramId,
    isAdmin: isAdmin(telegramId)
  });
}

function removeOnlineUser(socketId, shouldBroadcast = true) {
  const telegramId = socketPresence.get(socketId);
  if (!telegramId) {
    socketAuth.delete(socketId);
    return;
  }

  const entry = onlineUsers.get(telegramId);
  if (entry) {
    entry.connections.delete(socketId);
    if (entry.connections.size === 0) {
      onlineUsers.delete(telegramId);
    }
  }

  socketPresence.delete(socketId);
  socketAuth.delete(socketId);

  if (shouldBroadcast) {
    broadcastOnlineSummary();
  }
}

function getOnlineSummary() {
  const devices = {
    phone: 0,
    computer: 0,
    tablet: 0
  };

  let connections = 0;

  for (const entry of onlineUsers.values()) {
    for (const connection of entry.connections.values()) {
      connections += 1;
      const type = connection.device;
      if (Object.prototype.hasOwnProperty.call(devices, type)) {
        devices[type] += 1;
      }
    }
  }

  return {
    users: onlineUsers.size,
    connections,
    devices
  };
}

function broadcastOnlineSummary() {
  io.emit('onlineUsers', getOnlineSummary());
}

function getOnlineDetails() {
  return Array.from(onlineUsers.values())
    .map(entry => {
      const devices = {
        phone: 0,
        computer: 0,
        tablet: 0
      };

      for (const connection of entry.connections.values()) {
        if (Object.prototype.hasOwnProperty.call(devices, connection.device)) {
          devices[connection.device] += 1;
        }
      }

      return {
        telegramId: entry.telegramId,
        name: entry.name,
        connections: entry.connections.size,
        devices
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}

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

  const run = await runSongAction('replace', playbackState.authoritySocketId, 1500, async (actionVersion) => {

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
    setPlaybackForNewSong(nextSong, playbackState.authoritySocketId, { status: 'playing', position: 0 });

    io.emit('songPlayed', {
      song: nextSong,
      initiatorSocketId: null,
      action: lastAction,
      actionVersion,
      health: 5,
      likes: 0,
      dislikes: 0,
      replacementCountdown: null,
      playback: getPlaybackPayload()
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
  });

  return !!run?.success;
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
      const replaced = await run;

      // Nếu đang có Spin/Play/Auto action giữ lock, thử lại sau khi lock hết hạn.
      // Không retry vô hạn khi danh sách thực sự không còn bài.
      if (!replaced && getSongActionPayload().active && lastWinner && currentHealth === 0) {
        setTimeout(() => {
          const retry = voteQueue.then(() => replaceCurrentSongDueToHealth(), () => replaceCurrentSongDueToHealth());
          voteQueue = retry.catch(() => {});
        }, 600);
      }
      return;
    }

    broadcastReplacementCountdown();
  }, 1000);
}

async function performSpin(initiatorSocketId = null, actionUser = null) {
  return runSongAction('spin', initiatorSocketId, 5000, async (actionVersion) => {
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
      setPlaybackStopped();
      releaseSongActionLock(actionVersion);
      broadcastPlaybackState();
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
    setPlaybackForNewSong(winner, initiatorSocketId, {
      status: 'playing',
      position: 0,
      startAt: Date.now() + 4000
    });

    io.emit('triggerSpin', {
      selectedIndex,
      winner,
      initiatorSocketId,
      action: lastAction,
      actionVersion,
      playback: getPlaybackPayload()
    });
    broadcastState();
    return { success: true, winner, actionVersion };
  });
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

function isSocketConnected(socketId) {
  return !!socketId && !!io.sockets.sockets.get(socketId);
}

function getConnectedPlaybackAuthority(preferredSocketId = null) {
  if (isSocketConnected(preferredSocketId) && socketAuth.has(preferredSocketId)) {
    return preferredSocketId;
  }
  if (isSocketConnected(playbackState.authoritySocketId) && socketAuth.has(playbackState.authoritySocketId)) {
    return playbackState.authoritySocketId;
  }
  for (const [socketId, auth] of socketAuth.entries()) {
    if (auth?.telegramId && isSocketConnected(socketId)) return socketId;
  }
  return null;
}

function getAuthoritativePosition(now = Date.now()) {
  let position = Number(playbackState.position) || 0;
  if (playbackState.status === 'playing') {
    position += Math.max(0, now - Number(playbackState.serverTime || now)) / 1000;
  }
  return Math.max(0, position);
}

function setPlaybackForNewSong(song, authoritySocketId = null, options = {}) {
  const now = Date.now();
  playbackState = {
    songId: song?.id != null ? String(song.id) : null,
    status: options.status || 'playing',
    position: Math.max(0, Number(options.position) || 0),
    serverTime: now,
    version: playbackState.version + 1,
    authoritySocketId: getConnectedPlaybackAuthority(authoritySocketId),
    startAt: options.startAt || null,
    controlLockUntil: 0,
    controlLockSocketId: null
  };
  playbackSeekSuppressAuthorityUntil = 0;
  playbackSeekLock = { active: false, socketId: null, until: 0, token: playbackSeekLock.token + 1 };
  if (playbackSeekReleaseTimer) { clearTimeout(playbackSeekReleaseTimer); playbackSeekReleaseTimer = null; }
}

function setPlaybackStopped() {
  playbackState = {
    songId: null,
    status: 'stopped',
    position: 0,
    serverTime: Date.now(),
    version: playbackState.version + 1,
    authoritySocketId: null,
    startAt: null,
    controlLockUntil: 0,
    controlLockSocketId: null
  };
  playbackSeekSuppressAuthorityUntil = 0;
  playbackSeekLock = { active: false, socketId: null, until: 0, token: playbackSeekLock.token + 1 };
  if (playbackSeekReleaseTimer) { clearTimeout(playbackSeekReleaseTimer); playbackSeekReleaseTimer = null; }
}

function getPlaybackPayload() {
  const now = Date.now();
  return {
    songId: playbackState.songId,
    status: playbackState.status,
    position: getAuthoritativePosition(now),
    serverTime: now,
    version: playbackState.version,
    authoritySocketId: playbackState.authoritySocketId,
    startAt: playbackState.startAt,
    controlLockUntil: playbackState.controlLockUntil
  };
}

function broadcastPlaybackState(eventName = 'playbackState') {
  io.emit(eventName, getPlaybackPayload());
}

function updatePlaybackFromAuthority(socketId, songId, position, status, version) {
  if (socketId !== playbackState.authoritySocketId) return;
  if (playbackState.songId == null || String(songId) !== String(playbackState.songId)) return;
  if (Number(version) !== Number(playbackState.version)) return;

  const seekLock = getPlaybackSeekLockPayload();
  if (seekLock.active && seekLock.socketId !== socketId) return;
  if (Date.now() < playbackSeekSuppressAuthorityUntil) return;

  playbackState.position = Math.max(0, Number(position) || 0);
  playbackState.serverTime = Date.now();
  if (status === 'paused' || status === 'playing') {
    playbackState.status = status;
  }

  // Không broadcast mỗi lần authority báo vị trí.
  // Client tự extrapolate từ serverTime; chỉ broadcast khi có action/seek.
}

function getPlaybackSeekLockPayload() {
  const now = Date.now();
  if (playbackSeekLock.active && playbackSeekLock.until <= now) {
    playbackSeekLock = { active: false, socketId: null, until: 0, token: playbackSeekLock.token };
  }
  return { ...playbackSeekLock };
}

function broadcastPlaybackSeekLock() {
  io.emit('playbackSeekLock', getPlaybackSeekLockPayload());
}

function schedulePlaybackSeekLockRelease(token, delayMs = 500) {
  if (playbackSeekReleaseTimer) clearTimeout(playbackSeekReleaseTimer);
  playbackSeekReleaseTimer = setTimeout(() => {
    if (playbackSeekLock.token !== token) return;
    playbackSeekLock = { active: false, socketId: null, until: 0, token };
    playbackSeekReleaseTimer = null;
    broadcastPlaybackSeekLock();
  }, Math.max(0, delayMs));
}

function validateAdminSocket(socketId, auth) {
  if (!socketId || !auth?.user?.id) return false;
  const state = socketAuth.get(socketId);
  return !!state?.isAdmin && String(state.telegramId) === String(auth.user.id);
}

async function performPlaybackSeek(socketId, expectedSongId, position, lockToken) {
  if (!lastWinner || playbackState.songId == null || String(expectedSongId || '') !== String(lastWinner.id)) {
    return { success: false, status: 409, message: 'Bài đang phát đã thay đổi.', lock: getPlaybackSeekLockPayload() };
  }

  const lock = getPlaybackSeekLockPayload();
  if (!lock.active || lock.socketId !== socketId || Number(lockToken) !== Number(lock.token)) {
    return { success: false, status: 409, message: 'Bạn không còn quyền tua timeline.', lock };
  }

  const safePosition = Math.max(0, Number(position) || 0);
  const now = Date.now();

  playbackSeekSuppressAuthorityUntil = now + 2000;

  playbackState = {
    ...playbackState,
    position: safePosition,
    serverTime: now,
    version: playbackState.version + 1,
    startAt: null
  };

  broadcastPlaybackState();
  return { success: true, playback: getPlaybackPayload(), lock };
}

async function performPlaybackControl(socketId, action, expectedSongId) {
  const run = playbackControlQueue.then(async () => {
    const now = Date.now();

    if (!lastWinner || playbackState.songId == null || String(expectedSongId || '') !== String(lastWinner.id)) {
      return { success: false, status: 409, message: 'Bài đang phát đã thay đổi.' };
    }

    if (playbackState.controlLockUntil > now && playbackState.controlLockSocketId !== socketId) {
      return { success: false, status: 409, message: 'Một Admin khác vừa điều khiển. Vui lòng chờ một chút.', playback: getPlaybackPayload() };
    }

    const seekLock = getPlaybackSeekLockPayload();
    if (seekLock.active && seekLock.until > now && seekLock.socketId !== socketId) {
      return { success: false, status: 409, message: 'Một Admin khác đang tua timeline. Vui lòng chờ.', playback: getPlaybackPayload(), lock: seekLock };
    }

    const currentPosition = getAuthoritativePosition();
    const nextStatus = action === 'pause' ? 'paused' : 'playing';
    const lockMs = 900;

    playbackState = {
      ...playbackState,
      status: nextStatus,
      position: currentPosition,
      serverTime: Date.now(),
      version: playbackState.version + 1,
      controlLockUntil: Date.now() + lockMs,
      controlLockSocketId: socketId,
      startAt: null
    };

    broadcastPlaybackState();
    return { success: true, playback: getPlaybackPayload() };
  });
  playbackControlQueue = run.catch(() => {});
  return run;
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
    controllerSocketId: autoPlayControllerSocketId,
    playback: getPlaybackPayload()
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
    controllerSocketId: autoPlayControllerSocketId,
    online: getOnlineSummary(),
    playback: getPlaybackPayload(),
    songAction: getSongActionPayload(),
    playbackSeekLock: getPlaybackSeekLockPayload()
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
    return res.json({ success: false, stopAutoPlay: true, message: 'Auto Play đang tắt.' });
  }

  if (!socketId || socketId !== autoPlayControllerSocketId) {
    return res.status(403).json({ success: false, message: 'Không phải thiết bị Admin đang điều khiển Auto Play.' });
  }

  const result = await runSongAction('auto-play', socketId, 1500, async (actionVersion) => {
    const currentId = lastWinner?.id != null ? String(lastWinner.id) : null;

    if (expectedSongId != null && currentId !== String(expectedSongId)) {
      releaseSongActionLock(actionVersion);
      return { success: false, stale: true, message: 'Bỏ qua Auto Play cũ vì bài đang phát đã thay đổi.' };
    }

    const availableSongs = songs.filter(song => !currentId || String(song.id) !== currentId);
    if (availableSongs.length === 0) {
      setAutoPlayState(0);
      releaseSongActionLock(actionVersion);
      broadcastAutoPlayState();
      broadcastState();
      console.log('⏹ Auto Play dừng: không còn bài tiếp theo.');
      return { success: false, stopAutoPlay: true, message: 'Không còn bài hát tiếp theo.' };
    }

    let nextSong;
    if (autoPlayMode === 1) {
      nextSong = availableSongs[0];
    } else {
      const randomIndex = Math.floor(Math.random() * availableSongs.length);
      nextSong = availableSongs[randomIndex];
    }

    if (!nextSong) {
      releaseSongActionLock(actionVersion);
      return { success: false, status: 500, message: 'Không tìm được bài hát tiếp theo.' };
    }

    if (lastWinner && String(lastWinner.id) !== String(nextSong.id)) {
      await pool.query('DELETE FROM songs WHERE id = $1', [lastWinner.id]);
      songs = songs.filter(song => String(song.id) !== String(lastWinner.id));
    }

    lastWinner = nextSong;
    currentHealth = 5;
    currentLikeCount = 0;
    currentDislikeCount = 0;
    lastAction = null;
    clearReplacementCountdown();
    setPlaybackForNewSong(nextSong, autoPlayControllerSocketId, { status: 'playing', position: 0 });

    io.emit('songPlayed', {
      song: nextSong,
      initiatorSocketId: autoPlayControllerSocketId,
      action: null,
      actionVersion,
      health: 5,
      likes: 0,
      dislikes: 0,
      replacementCountdown: null,
      playback: getPlaybackPayload()
    });
    broadcastState();

    console.log(autoPlayMode === 1 ? `🔢 Auto tuần tự → #${nextSong.id}` : `🔀 Auto ngẫu nhiên → #${nextSong.id}`);
    return { success: true, song: nextSong, mode: autoPlayMode, actionVersion };
  });

  if (result.status) return res.status(result.status).json(result);
  return res.json(result);
});

// ==================== API: PLAY ONE SONG ====================
// Tất cả user đều được phép phát.
// Người bấm Play nghe tiếng; các client khác phát mute.
app.post('/api/play-song', async (req, res) => {
  const { id, initData, socketId } = req.body;

  if (!id) return res.status(400).json({ success: false, message: 'Thiếu ID bài hát!' });

  const auth = validateTelegramInitData(initData);
  if (!auth.valid) {
    return res.status(401).json({ success: false, message: `Xác thực Telegram thất bại: ${auth.message}` });
  }

  const result = await runSongAction('play', socketId || null, 1500, async (actionVersion) => {
    const songResult = await pool.query(`
      SELECT id, url, title, user_name AS user, telegram_id AS "telegramId", created_at
      FROM songs WHERE id = $1
    `, [id]);

    if (songResult.rowCount === 0) {
      releaseSongActionLock(actionVersion);
      return { success: false, status: 404, message: 'Không tìm thấy bài hát!' };
    }

    const song = songResult.rows[0];

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

    const userName = [auth.user.first_name, auth.user.last_name].filter(Boolean).join(' ').trim() || 'Người dùng';
    lastAction = { type: 'play', user: userName };
    setPlaybackForNewSong(song, socketId, { status: 'playing', position: 0 });

    io.emit('songPlayed', {
      song,
      initiatorSocketId: socketId || null,
      action: lastAction,
      actionVersion,
      health: 5,
      likes: 0,
      dislikes: 0,
      replacementCountdown: null,
      playback: getPlaybackPayload()
    });
    broadcastState();

    console.log(`▶️ Phát bài hát #${song.id}: ${song.title || song.url}`);
    return { success: true, song, actionVersion };
  });

  if (result.status) return res.status(result.status).json(result);
  return res.json(result);
});

// ==================== API: PLAYBACK TIMELINE SEEK ====================
app.post('/api/playback-seek-lock', async (req, res) => {
  const { action, socketId, expectedSongId, lockToken } = req.body || {};
  const auth = requireTelegramAdmin(req, res);
  if (!auth.ok) return;

  if (!validateAdminSocket(socketId, auth)) {
    return res.status(403).json({ success: false, message: 'Socket Admin không hợp lệ.' });
  }

  const now = Date.now();
  const currentLock = getPlaybackSeekLockPayload();

  if (action === 'acquire') {
    if (getSongActionPayload().active) {
      return res.status(409).json({ success: false, message: 'Đang xử lý thao tác chọn bài. Vui lòng chờ.', lock: currentLock });
    }

    if (!lastWinner || playbackState.songId == null || String(expectedSongId || '') !== String(lastWinner.id)) {
      return res.status(409).json({ success: false, message: 'Bài đang phát đã thay đổi.', lock: currentLock });
    }

    if (currentLock.active && currentLock.until > now && currentLock.socketId !== socketId) {
      return res.status(409).json({ success: false, message: 'Một Admin khác đang tua timeline.', lock: currentLock });
    }

    if (playbackSeekReleaseTimer) {
      clearTimeout(playbackSeekReleaseTimer);
      playbackSeekReleaseTimer = null;
    }

    playbackSeekLock = {
      active: true,
      socketId,
      until: now + 60 * 60 * 1000,
      token: Number(playbackSeekLock.token || 0) + 1
    };

    broadcastPlaybackSeekLock();
    return res.json({ success: true, lock: getPlaybackSeekLockPayload(), playback: getPlaybackPayload() });
  }

  if (action === 'release') {
    if (!currentLock.active || currentLock.socketId !== socketId || Number(lockToken) !== Number(currentLock.token)) {
      return res.status(409).json({ success: false, message: 'Bạn không còn giữ quyền tua.', lock: currentLock });
    }

    // Nhả quyền nhưng giữ lock thêm đúng 500ms để các Admin khác không
    // giành quyền ngay đúng thời điểm pointerup.
    playbackSeekLock = {
      active: true,
      socketId,
      until: now + 500,
      token: currentLock.token
    };
    broadcastPlaybackSeekLock();
    schedulePlaybackSeekLockRelease(currentLock.token, 500);
    return res.json({ success: true, lock: getPlaybackSeekLockPayload() });
  }

  return res.status(400).json({ success: false, message: 'Hành động lock không hợp lệ.' });
});

app.post('/api/playback-seek', async (req, res) => {
  const { socketId, expectedSongId, position, lockToken } = req.body || {};
  const auth = requireTelegramAdmin(req, res);
  if (!auth.ok) return;

  if (!validateAdminSocket(socketId, auth)) {
    return res.status(403).json({ success: false, message: 'Socket Admin không hợp lệ.' });
  }

  const actionLock = getSongActionPayload();
  if (actionLock.active) {
    return res.status(409).json({ success: false, message: 'Đang xử lý thao tác chọn bài. Không thể tua lúc này.', lock: getPlaybackSeekLockPayload() });
  }

  const result = await performPlaybackSeek(socketId, expectedSongId, position, lockToken);
  if (result.status) return res.status(result.status).json(result);
  return res.json(result);
});

// ==================== API: PLAYBACK CONTROL ====================
app.post('/api/playback-control', async (req, res) => {
  const { action, socketId, expectedSongId } = req.body || {};
  const auth = requireTelegramAdmin(req, res);
  if (!auth.ok) return;

  if (!['play', 'pause'].includes(action)) {
    return res.status(400).json({ success: false, message: 'Lệnh playback không hợp lệ.' });
  }

  const result = await performPlaybackControl(socketId, action, expectedSongId);
  if (result.status) return res.status(result.status).json(result);
  return res.json(result);
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
    if (result.status) return res.status(result.status).json(result);
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
    setPlaybackStopped();

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
      setPlaybackStopped();
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

  socket.on('authenticate', (payload = {}) => {
    const initData = payload.initData || '';
    const deviceInfo = payload.deviceInfo || {};
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

    // Gửi snapshot sau khi Telegram đã xác thực, tránh race khi reload.
    const playbackSnapshot = getPlaybackPayload();
    socket.emit('stateUpdate', {
      isFormOpen,
      songs,
      lastWinner,
      lastAction,
      health: currentHealth,
      likes: currentLikeCount,
      dislikes: currentDislikeCount,
      replacementCountdown,
      autoPlayMode,
      controllerSocketId: autoPlayControllerSocketId,
      online: getOnlineSummary(),
      playback: playbackSnapshot,
      songAction: getSongActionPayload(),
      playbackSeekLock: getPlaybackSeekLockPayload()
    });
    socket.emit('autoPlayMode', {
      mode: autoPlayMode,
      controllerSocketId: autoPlayControllerSocketId,
      playback: playbackSnapshot
    });
    socket.emit('songActionLock', getSongActionPayload());
    socket.emit('playbackSeekLock', getPlaybackSeekLockPayload());

    addOnlineUser(socket, auth.user, deviceInfo);
    broadcastOnlineSummary();

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

  socket.on('requestPlaybackState', () => {
    const authState = socketAuth.get(socket.id);
    if (!authState?.telegramId) return;

    const playbackSnapshot = getPlaybackPayload();
    socket.emit('stateUpdate', {
      isFormOpen,
      songs,
      lastWinner,
      lastAction,
      health: currentHealth,
      likes: currentLikeCount,
      dislikes: currentDislikeCount,
      replacementCountdown,
      autoPlayMode,
      controllerSocketId: autoPlayControllerSocketId,
      online: getOnlineSummary(),
      playback: playbackSnapshot,
      songAction: getSongActionPayload(),
      playbackSeekLock: getPlaybackSeekLockPayload()
    });
  });

  socket.on('playbackReport', (payload = {}) => {
    updatePlaybackFromAuthority(
      socket.id,
      payload.songId,
      payload.position,
      payload.status,
      payload.version
    );
  });

  socket.on('requestOnlineDetails', () => {
    const authState = socketAuth.get(socket.id);

    if (!authState?.isAdmin) {
      return;
    }

    socket.emit('onlineDetails', {
      users: getOnlineDetails(),
      summary: getOnlineSummary()
    });
  });

  socket.on('disconnect', (reason) => {
    console.log(`🔌 Socket disconnected: ${socket.id} | ${reason}`);

    removeOnlineUser(socket.id, true);

    if (playbackSeekLock.socketId === socket.id) {
      playbackSeekLock = { active: true, socketId: null, until: Date.now() + 500, token: playbackSeekLock.token + 1 };
      broadcastPlaybackSeekLock();
      schedulePlaybackSeekLockRelease(playbackSeekLock.token, 500);
    }

    if (socket.id === playbackState.authoritySocketId) {
      const positionAtDisconnect = getAuthoritativePosition();
      playbackState.position = positionAtDisconnect;
      playbackState.serverTime = Date.now();
      playbackState.authoritySocketId = getConnectedPlaybackAuthority(null);
      broadcastPlaybackState();
    }

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
