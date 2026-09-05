// ==================== YOUTUBE URL PARSER (DÙNG CHUNG) ====================
// File này được dùng bởi CẢ server (require) VÀ client (<script src>).
// Chỉnh sửa logic parse link YouTube CHỈ ở đây — không viết lại ở nơi khác.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    // Node.js (server)
    module.exports = factory();
  } else {
    // Browser (client) — gắn vào window
    root.YouTubeUtils = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  /**
   * Trích xuất video ID từ mọi dạng link YouTube:
   *   youtube.com/watch?v=ID | youtu.be/ID | youtube.com/shorts/ID
   *   youtube.com/embed/ID   | youtube.com/live/ID | music.youtube.com/watch?v=ID
   * @returns {string|null} video ID (11 ký tự) hoặc null nếu không hợp lệ
   */
  // YouTube video ID luôn là 11 ký tự [A-Za-z0-9_-].
  const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

  function getYouTubeVideoId(inputUrl) {
    try {
      const url = new URL(String(inputUrl).trim());
      const hostname = url.hostname
        .toLowerCase()
        .replace(/^www\./, '');

      let candidate = null;

      if (hostname === 'youtu.be') {
        candidate = url.pathname.split('/').filter(Boolean)[0] || null;
      } else if (
        hostname === 'youtube.com' ||
        hostname === 'm.youtube.com' ||
        hostname === 'music.youtube.com'
      ) {
        candidate = url.searchParams.get('v');

        if (!candidate) {
          const parts = url.pathname.split('/').filter(Boolean);
          if (
            parts.length >= 2 &&
            ['shorts', 'embed', 'live'].includes(parts[0])
          ) {
            candidate = parts[1];
          }
        }
      }

      // Chặn chuỗi rác (quá ngắn/dài, ký tự lạ) trước khi lưu xuống DB.
      return candidate && VIDEO_ID_PATTERN.test(candidate) ? candidate : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Kiểm tra nhanh link có phải YouTube hợp lệ hay không.
   * Dùng thay cho isYouTubeUrl() cũ ở client.
   */
  function isValidYouTubeUrl(inputUrl) {
    return getYouTubeVideoId(inputUrl) !== null;
  }

  return { getYouTubeVideoId, isValidYouTubeUrl };
}));
