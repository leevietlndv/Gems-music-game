jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 })
  }))
}));

jest.mock('telegraf', () => ({
  Telegraf: jest.fn(() => {
    const bot = {
      launch: jest.fn().mockResolvedValue(true),
      catch: jest.fn(),
      telegram: new Proxy({}, {
        get: () => jest.fn().mockResolvedValue(true)
      })
    };
    // Every bot method (command, on, action, ...) is a chainable no-op.
    return new Proxy(bot, {
      get: (target, prop) => {
        if (prop in target) return target[prop];
        target[prop] = () => bot;
        return target[prop];
      }
    });
  }),
  Markup: {}
}));

jest.mock('socket.io', () => ({
  Server: jest.fn(() => ({ on: jest.fn(), emit: jest.fn() }))
}));

jest.mock('express', () => {
  const chainable = () => {
    const fn = jest.fn();
    return new Proxy(fn, {
      get: (target, prop) => {
        if (prop === 'listen') return jest.fn();
        return chainable();
      },
      apply: () => chainable()
    });
  };
  const express = jest.fn(() => chainable());
  // Static middleware factories: express.json(), express.static(), ...
  express.json = jest.fn(() => jest.fn((req, res, next) => next()));
  express.static = jest.fn(() => jest.fn((req, res, next) => next()));
  return express;
});

const crypto = require('crypto');

process.env.BOT_TOKEN = '123456:TEST-TOKEN';
process.env.ADMIN_IDS = '111,222';
process.env.DATABASE_URL = 'postgres://test';

const {
  clampHealth, // still exercised below via targeted describe block
  detectDeviceType,
  isAdmin,
  validateTelegramInitData,
  addOnlineUser,
  removeOnlineUser,
  getOnlineSummary,
  getOnlineDetails,
  onlineUsers,
  socketPresence,
  socketAuth
} = require('../server');

function makeSocket(id) {
  return { id, emit: jest.fn(), on: jest.fn() };
}

// Helper: build a signed Telegram initData string like the real client does.
function buildInitData(overrides = {}, token = process.env.BOT_TOKEN) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAF_test',
    user: JSON.stringify({ id: 42, first_name: 'Gems' }),
    ...overrides
  });
  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(token)
    .digest();
  const hash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');
  params.set('hash', hash);
  return params.toString();
}

beforeEach(() => {
  onlineUsers.clear();
  socketPresence.clear();
  socketAuth.clear();
});

describe('detectDeviceType (edge cases)', () => {
  test('uses its default argument when called with no input', () => {
    expect(detectDeviceType()).toBe('phone');
  });

  test('treats null as the default empty deviceInfo', () => {
    expect(detectDeviceType(null)).toBe('phone');
  });

  test('coerces non-string platform/userAgent values', () => {
    expect(detectDeviceType({ platform: 42, userAgent: 123 })).toBe('phone');
    expect(detectDeviceType({ platform: null, userAgent: undefined })).toBe('phone');
  });

  test('android UA wins tablet check before desktop linux check', () => {
    // "linux" + "android" without "mobile" -> tablet, not computer
    expect(detectDeviceType({ platform: 'android', userAgent: 'Linux; Android 13' })).toBe('tablet');
  });

  test('ipad platform beats an android-style UA', () => {
    expect(detectDeviceType({ platform: 'ipad', userAgent: 'Android' })).toBe('tablet');
  });
});

describe('clampHealth', () => {
  test.each([
    [0, 0],
    [5, 5],
    [3, 3],
    [-1, 0],        // below range -> clamped to 0
    [-100, 0],
    [6, 5],         // above range -> clamped to 5
    [100, 5],
    [4.7, 4.7],     // fractional values pass through unchanged
    ['3', 3],       // numeric string is coerced
    ['-2', 0],
    ['7', 5],
    ['', 0],        // falsy string -> 0 via Number('')||0 path... ('' -> 0)
    [null, 0],
    [undefined, 0],
    [NaN, 0],
    ['abc', 0],     // non-numeric string -> 0
    [true, 1],      // boolean coercion: Number(true) = 1
    [false, 0],
    [Infinity, 5],  // Math.min caps Infinity
    [-Infinity, 0]
  ])('clampHealth(%p) => %p', (input, expected) => {
    expect(clampHealth(input)).toBe(expected);
  });
});

describe('detectDeviceType', () => {
  test.each([
    [{}, 'phone'],                                        // no info -> default phone
    [{ platform: 'ios' }, 'phone'],
    [{ platform: 'android', userAgent: 'Android Mobile' }, 'phone'],
    [{ platform: 'android' }, 'phone'],                   // platform alone is not enough -> phone
    [{ userAgent: 'iPad; CPU OS 16' }, 'tablet'],
    [{ platform: 'ipad' }, 'tablet'],
    [{ platform: 'tdesktop' }, 'computer'],
    [{ platform: 'macos' }, 'computer'],
    [{ platform: 'windows' }, 'computer'],
    [{ platform: 'linux' }, 'computer'],
    [{ platform: 'unknown' }, 'phone'],                   // unrecognized platform falls through
    [{ userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }, 'computer'],
    [{ userAgent: 'Macintosh' }, 'computer'],
    [{ userAgent: 'X11; Linux x86_64' }, 'computer'],
    [{ userAgent: 'Linux; Android 13; Mobile' }, 'phone'],// android+mobile stays phone
    [{ platform: 'LINUX' }, 'computer']                   // case-insensitive platform
  ])('detectDeviceType(%j) => %s', (input, expected) => {
    expect(detectDeviceType(input)).toBe(expected);
  });
});

describe('isAdmin', () => {
  test('returns true for configured admin ids (string or number)', () => {
    expect(isAdmin('111')).toBe(true);
    expect(isAdmin(222)).toBe(true);
  });

  test('returns false for a non-admin id', () => {
    expect(isAdmin('999')).toBe(false);
  });

  test.each([null, undefined])('returns false for %p', (input) => {
    expect(isAdmin(input)).toBe(false);
  });
});

describe('validateTelegramInitData', () => {
  test('accepts valid, fresh initData and returns the user', () => {
    const result = validateTelegramInitData(buildInitData());
    expect(result.valid).toBe(true);
    expect(result.user).toEqual({ id: 42, first_name: 'Gems' });
  });

  test('rejects empty or null initData', () => {
    expect(validateTelegramInitData('').valid).toBe(false);
    expect(validateTelegramInitData(null).valid).toBe(false);
  });

  test('rejects initData without a hash', () => {
    const data = buildInitData().replace(/&hash=[^&]*/, '');
    expect(validateTelegramInitData(data).valid).toBe(false);
  });

  test('rejects a signature created with a different bot token', () => {
    const data = buildInitData({}, '999:OTHER-TOKEN');
    expect(validateTelegramInitData(data).valid).toBe(false);
  });

  test('rejects data tampered after signing', () => {
    const data = buildInitData().replace('Gems', 'Hacker');
    expect(validateTelegramInitData(data).valid).toBe(false);
  });

  test('rejects expired auth_date (> 24h old)', () => {
    const old = Math.floor(Date.now() / 1000) - 25 * 60 * 60;
    expect(validateTelegramInitData(buildInitData({ auth_date: String(old) })).valid).toBe(false);
  });

  test('rejects missing auth_date', () => {
    expect(validateTelegramInitData(buildInitData({ auth_date: '' })).valid).toBe(false);
  });

  test('rejects malformed JSON user payload', () => {
    expect(validateTelegramInitData(buildInitData({ user: 'not-json' })).valid).toBe(false);
  });

  test('rejects a user without an id', () => {
    const data = buildInitData({ user: JSON.stringify({ first_name: 'X' }) });
    expect(validateTelegramInitData(data).valid).toBe(false);
  });
});

describe('presence: addOnlineUser / removeOnlineUser / summaries', () => {
  const user42 = { id: 42, first_name: 'Gems', last_name: 'Bai' };
  const user7 = { id: 7, username: 'alone' };
  const user99 = { id: 99 }; // no names at all -> fallback name

  test('adds a user with full name and registers presence/auth', () => {
    addOnlineUser(makeSocket('s1'), user42, { platform: 'ios' });
    expect(getOnlineSummary()).toEqual({
      users: 1,
      connections: 1,
      devices: { phone: 1, computer: 0, tablet: 0 }
    });
    expect(socketPresence.get('s1')).toBe('42');
    expect(socketAuth.get('s1')).toEqual({ telegramId: '42', isAdmin: false });
    expect(onlineUsers.get('42').name).toBe('Gems Bai');
  });

  test('falls back to username, then to the default name', () => {
    addOnlineUser(makeSocket('s2'), user7, {});
    expect(onlineUsers.get('7').name).toBe('alone');
    addOnlineUser(makeSocket('s3'), user99, {});
    expect(onlineUsers.get('99').name).toBe('Ng\u01b0\u1eddi d\u00f9ng');
  });

  test('same user on two devices counts as 1 user, 2 connections', () => {
    addOnlineUser(makeSocket('s1'), user42, { platform: 'ios' });
    addOnlineUser(makeSocket('s2'), user42, { platform: 'tdesktop' });
    const summary = getOnlineSummary();
    expect(summary.users).toBe(1);
    expect(summary.connections).toBe(2);
    expect(summary.devices).toEqual({ phone: 1, computer: 1, tablet: 0 });
  });

  test('re-authenticating a socket with a different user moves presence', () => {
    addOnlineUser(makeSocket('s1'), user42, {});
    addOnlineUser(makeSocket('s1'), user7, {});
    expect(onlineUsers.has('42')).toBe(false);
    expect(socketPresence.get('s1')).toBe('7');
    expect(getOnlineSummary().users).toBe(1);
  });

  test('marks an admin in socketAuth', () => {
    addOnlineUser(makeSocket('s1'), { id: 111 }, {});
    expect(socketAuth.get('s1').isAdmin).toBe(true);
  });

  test('removing the only socket removes the user; unknown socket is a no-op', () => {
    addOnlineUser(makeSocket('s1'), user42, {});
    removeOnlineUser('s1', false);
    expect(getOnlineSummary().users).toBe(0);
    expect(() => removeOnlineUser('does-not-exist', false)).not.toThrow();
  });

  test('removing one of two sockets keeps the user online', () => {
    addOnlineUser(makeSocket('s1'), user42, {});
    addOnlineUser(makeSocket('s2'), user42, {});
    removeOnlineUser('s1', false);
    expect(getOnlineSummary()).toMatchObject({ users: 1, connections: 1 });
  });

  test('getOnlineDetails returns a vi-locale sorted device breakdown', () => {
    addOnlineUser(makeSocket('s1'), user42, { platform: 'ios' });
    addOnlineUser(makeSocket('s2'), { id: 5, first_name: 'Ann' }, { platform: 'tdesktop' });
    const details = getOnlineDetails();
    expect(details).toHaveLength(2);
    expect(details[0].name).toBe('Ann');
    const gems = details.find(d => d.telegramId === '42');
    expect(gems).toEqual({
      telegramId: '42',
      name: 'Gems Bai',
      connections: 1,
      devices: { phone: 1, computer: 0, tablet: 0 }
    });
  });

  test('removeOnlineUser with shouldBroadcast=true does not throw (io mocked)', () => {
    addOnlineUser(makeSocket('s1'), user42, {});
    expect(() => removeOnlineUser('s1', true)).not.toThrow();
  });
});

// ==================== ADDITIONAL EDGE CASES ====================

describe('validateTelegramInitData (extra edge cases)', () => {
  test('accepts a future-dated auth_date (not expired)', () => {
    const future = Math.floor(Date.now() / 1000) + 60;
    const result = validateTelegramInitData(buildInitData({ auth_date: String(future) }));
    expect(result.valid).toBe(true);
  });

  test('accepts auth_date exactly at the 24h boundary', () => {
    const boundary = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    const result = validateTelegramInitData(buildInitData({ auth_date: String(boundary) }));
    expect(result.valid).toBe(true);
  });

  test('rejects auth_date just past the 24h boundary', () => {
    const past = Math.floor(Date.now() / 1000) - 24 * 60 * 60 - 2;
    const result = validateTelegramInitData(buildInitData({ auth_date: String(past) }));
    expect(result.valid).toBe(false);
  });

  test('rejects a non-hex hash without throwing', () => {
    const data = buildInitData().replace(/hash=[0-9a-f]+/, 'hash=zzzz');
    expect(() => validateTelegramInitData(data)).not.toThrow();
    expect(validateTelegramInitData(data).valid).toBe(false);
  });

  test('rejects whitespace-only initData', () => {
    expect(validateTelegramInitData('   ').valid).toBe(false);
  });
});

describe('presence (extra edge cases)', () => {
  const user42 = { id: 42, first_name: 'Gems' };

  test('summary stays consistent with unknown device types in the map', () => {
    // Simulate corrupted data: an entry whose device is not phone/computer/tablet
    addOnlineUser(makeSocket('s1'), user42, {});
    onlineUsers.get('42').connections.get('s1').device = 'fridge';
    const summary = getOnlineSummary();
    expect(summary.users).toBe(1);
    expect(summary.connections).toBe(1);
    expect(summary.devices).toEqual({ phone: 0, computer: 0, tablet: 0 });
  });

  test('details survive unknown device types without inflating counts', () => {
    addOnlineUser(makeSocket('s1'), user42, {});
    onlineUsers.get('42').connections.get('s1').device = 'fridge';
    const details = getOnlineDetails();
    expect(details[0].devices).toEqual({ phone: 0, computer: 0, tablet: 0 });
    expect(details[0].connections).toBe(1);
  });

  test('removing an already-removed socket twice is idempotent', () => {
    addOnlineUser(makeSocket('s1'), user42, {});
    removeOnlineUser('s1', false);
    expect(() => removeOnlineUser('s1', false)).not.toThrow();
    expect(getOnlineSummary()).toEqual({
      users: 0,
      connections: 0,
      devices: { phone: 0, computer: 0, tablet: 0 }
    });
  });

  test('presence map is fully cleaned up after disconnect', () => {
    addOnlineUser(makeSocket('s1'), user42, {});
    removeOnlineUser('s1', false);
    expect(socketPresence.has('s1')).toBe(false);
    expect(socketAuth.has('s1')).toBe(false);
    expect(onlineUsers.has('42')).toBe(false);
  });

  test('re-auth keeps one entry when the same user re-adds the same socket', () => {
    addOnlineUser(makeSocket('s1'), { id: 42, first_name: 'Old' }, {});
    addOnlineUser(makeSocket('s1'), { id: 42, first_name: 'New' }, {});
    expect(getOnlineSummary()).toMatchObject({ users: 1, connections: 1 });
    expect(onlineUsers.get('42').name).toBe('New');
  });
});
