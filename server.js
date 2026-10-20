/**
 * 后端代理服务器 - Node.js + Express
 *
 * 架构：H5 前端 → 本服务 → xbsms.work API
 * 作用：解决浏览器 CORS 跨域问题，由服务端转发请求
 *
 * 响应规范（见 API 文档）：
 *   成功 → 直接返回数据（手机号 / 短信内容 / ok）
 *   失败 → ERROR:错误信息
 * 注意：实测上游返回的是 JSON 编码字符串（带双引号），需先解包再判断！
 */

const express = require('express');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// ====== 写死配置 ======
const API_KEY    = 'sk_live_da68e79e1c093bba70ff8739a35862c934a1b3c085929197';
const CARD_TYPE  = '实卡';
const KEYWORD    = '多点';
const KEYWORDS   = [
  '抖音', '微信', '淘宝', '支付宝', '京东',
  '拼多多', '美团', '快手', '百度', '网易',
  '腾讯视频', '爱奇艺', '优酷', 'B站', '小红书',
  '滴滴', '携程', '12306', '建设银行', '工商银行',
  '多点',
];

// ====== 中间件 ======
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname)));

// ====== 响应解析 ======
/**
 * 解包上游响应体。
 * 上游实际可能返回：
 *   "ERROR:xxx"（JSON 编码字符串，带引号）  → ERROR:xxx
 *   "13800138000"                          → 13800138000
 *   ERROR:xxx / 13800138000（纯文本）      → 原样
 */
function normalizeBody(raw) {
  let text = (raw == null ? '' : String(raw)).trim();
  if (!text) return '';

  // 1) 尝试 JSON 解析，解掉外层编码
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string') {
      text = parsed.trim();
    } else if (parsed && typeof parsed === 'object') {
      // 兼容偶发的 JSON 对象响应
      if (typeof parsed.data === 'string')       text = parsed.data.trim();
      else if (typeof parsed.error === 'string') text = ('ERROR:' + parsed.error).trim();
      else if (typeof parsed.msg === 'string')   text = parsed.msg.trim();
    }
  } catch (_) { /* 非 JSON，按纯文本处理 */ }

  // 2) 兜底：去掉残留的成对引号
  const len = text.length;
  if (len >= 2) {
    const first = text[0], last = text[len - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      text = text.slice(1, -1).trim();
    }
  }
  return text;
}

/** 是否为接口错误（文档格式：ERROR:错误信息） */
function isApiError(text) {
  return /^ERROR:/i.test(text);
}

/**
 * 是否为「可重试」的临时状态。
 * 文档：getMsg 未收到短信 → ERROR:未收到短信（轮询过程中的正常状态，应继续等）
 */
function isRetryable(text) {
  return /未收到短信/.test(text);
}

/** 统一返回给前端：失败绝不包装成 ok:true */
function sendResult(res, raw) {
  const text = normalizeBody(raw);
  console.log(`[解析] 原始=${JSON.stringify(raw)} → 结果=${JSON.stringify(text)}`);

  if (!text) {
    return res.json({ ok: false, error: '接口返回为空', retryable: false });
  }
  if (isApiError(text)) {
    return res.json({ ok: false, error: text, retryable: isRetryable(text) });
  }
  return res.json({ ok: true, data: text });
}

/** 清洗手机号：去掉引号/空格等杂质，只留数字 */
function cleanPhone(phone) {
  return String(phone == null ? '' : phone).replace(/["'\s]/g, '').replace(/\D/g, '');
}

// ====== 用户会话：一个用户同时只能有一个号码 ======
// key = 客户端 IP，value = 当前占用的号码
const userSessions = new Map();

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// ====== 通用代理 ======
function proxyToApi(endpoint, params, callback) {
  const qs = new URLSearchParams(params).toString();
  const fullUrl = `https://xbsms.work/api/external/${endpoint}?${qs}`;

  console.log(`[代理] ${endpoint} ? ${qs.replace(API_KEY, API_KEY.slice(0, 12) + '...')}`);

  const parsed = new URL(fullUrl);
  const options = {
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; xbsms-tool/1.0)',
      'Accept': '*/*',
    },
  };

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      console.log(`[代理] ${endpoint} 原始响应: ${data}`);
      callback(null, data);
    });
  });

  req.on('error', (err) => {
    console.error(`[代理] ${endpoint} 错误: ${err.message}`);
    callback(err);
  });

  req.end();
}

// ====== API 路由 ======

// 获取手机号（一个用户同时只能占用一个号码）
app.post('/api/getPhone', (req, res) => {
  const { province, phone } = req.body;
  const ip = getClientIp(req);

  // 已有号码未释放 → 拒绝再取（获取失败的情况不会写入会话，可重试）
  const held = userSessions.get(ip);
  if (held) {
    return res.json({
      ok: false,
      error: `您已获取号码 ${held}，请先释放或拉黑后再获取新号码`,
      code: 'HELD',
      heldPhone: held,
    });
  }

  const params = {
    token: API_KEY,
    keyWord: KEYWORD,
    province: province || '全部',
    cardType: CARD_TYPE,
  };
  const targetPhone = cleanPhone(phone);
  if (targetPhone) params.phone = targetPhone;

  proxyToApi('getPhone', params, (err, data) => {
    if (err) return res.json({ ok: false, error: err.message, retryable: false });
    // 号码也要解包清洗，防止带引号的号码发给 getMsg 导致「未找到会话」
    const text = normalizeBody(data);
    if (!text) return res.json({ ok: false, error: '接口返回为空', retryable: false });
    if (isApiError(text)) return res.json({ ok: false, error: text, retryable: false });
    const clean = text.replace(/\D/g, '');
    if (!clean) return res.json({ ok: false, error: '返回的号码无效: ' + text, retryable: false });
    // 取号成功才占用名额；失败不占用，用户可直接重试
    userSessions.set(ip, clean);
    console.log(`[会话] ${ip} 取号 ${clean}（当前占用 ${userSessions.size} 个用户）`);
    res.json({ ok: true, data: clean });
  });
});

// 获取短信
app.post('/api/getMsg', (req, res) => {
  const { phone } = req.body;
  const targetPhone = cleanPhone(phone);
  if (!targetPhone) return res.json({ ok: false, error: '缺少手机号', retryable: false });

  proxyToApi('getMsg', { token: API_KEY, phone: targetPhone, keyWord: KEYWORD }, (err, data) => {
    if (err) return res.json({ ok: false, error: err.message, retryable: false });
    sendResult(res, data);
  });
});

// 释放号码（成功后归还名额；会话已失效也归还）
app.post('/api/release', (req, res) => {
  const targetPhone = cleanPhone(req.body.phone);
  if (!targetPhone) return res.json({ ok: false, error: '缺少手机号', retryable: false });
  const ip = getClientIp(req);

  proxyToApi('release', { token: API_KEY, phone: targetPhone }, (err, data) => {
    if (err) return res.json({ ok: false, error: err.message, retryable: false });
    const text = normalizeBody(data);
    // 成功（ok）或会话已不存在 → 都视为释放完成，归还名额
    if (!isApiError(text) || /未找到该号码的会话|会话不存在/.test(text)) {
      if (userSessions.get(ip) === targetPhone) userSessions.delete(ip);
      console.log(`[会话] ${ip} 释放 ${targetPhone}（当前占用 ${userSessions.size} 个用户）`);
    }
    sendResult(res, data);
  });
});

// 拉黑号码（成功后归还名额；会话已失效也归还）
app.post('/api/block', (req, res) => {
  const targetPhone = cleanPhone(req.body.phone);
  if (!targetPhone) return res.json({ ok: false, error: '缺少手机号', retryable: false });
  const ip = getClientIp(req);

  proxyToApi('block', { token: API_KEY, phone: targetPhone }, (err, data) => {
    if (err) return res.json({ ok: false, error: err.message, retryable: false });
    const text = normalizeBody(data);
    if (!isApiError(text) || /未找到该号码的会话|会话不存在/.test(text)) {
      if (userSessions.get(ip) === targetPhone) userSessions.delete(ip);
      console.log(`[会话] ${ip} 拉黑 ${targetPhone}（当前占用 ${userSessions.size} 个用户）`);
    }
    sendResult(res, data);
  });
});

// 查询当前用户占用的号码（刷新页面后恢复状态用）
app.get('/api/myPhone', (req, res) => {
  const ip = getClientIp(req);
  const held = userSessions.get(ip);
  res.json({ ok: true, phone: held || null });
});

// ====== 配置查询接口（前端读取可用关键词） ======
app.get('/api/config', (req, res) => {
  res.json({ ok: true, keywords: KEYWORDS, cardType: CARD_TYPE, keyWord: KEYWORD });
});

// ====== 启动 ======
app.listen(PORT, () => {
  console.log('');
  console.log('  🚀 短信验证工具已启动');
  console.log(`  📡 地址: http://localhost:${PORT}`);
  console.log(`  📤 代理: https://xbsms.work/api/external`);
  console.log(`  🔑 密钥: ${API_KEY.slice(0, 12)}...`);
  console.log(`  🔎 关键词: ${KEYWORD}（固定）`);
  console.log(`  📱 卡类型: ${CARD_TYPE}`);
  console.log('');
});
