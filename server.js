/**
 * 后端代理服务器 - Node.js + Express
 *
 * 架构：H5 前端 → 本服务 → xbsms.work API
 * 作用：解决浏览器 CORS 跨域问题，由服务端转发请求
 */

const express = require('express');
const path = require('path');
const https = require('https');
const url = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// ====== 中间件 ======
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS 允许所有来源（生产环境应限制）
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// 静态文件服务
app.use(express.static(path.join(__dirname)));

// ====== 配置 ======
const API_BASE = 'https://xbsms.work/api/external';

// ====== 通用代理函数 ======
function proxyToApi(endpoint, params, callback) {
  const qs = new URLSearchParams(params).toString();
  const fullUrl = `${API_BASE}/${endpoint}?${qs}`;

  console.log(`[代理] ${endpoint} ? ${qs}`);

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
      console.log(`[代理] ${endpoint} 响应: ${data}`);
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

// 获取手机号
app.post('/api/getPhone', (req, res) => {
  const { token, keyWord, province, cardType, phone } = req.body;
  if (!token) return res.json({ ok: false, error: '缺少 API 密钥' });
  if (!keyWord) return res.json({ ok: false, error: '缺少关键词' });

  const params = { token, keyWord, province: province || '全部', cardType: cardType || '全部' };
  if (phone) params.phone = phone;

  proxyToApi('getPhone', params, (err, data) => {
    if (err) return res.json({ ok: false, error: err.message });
    if (data.startsWith('ERROR:')) return res.json({ ok: false, error: data });
    res.json({ ok: true, data: data.trim() });
  });
});

// 获取短信
app.post('/api/getMsg', (req, res) => {
  const { token, phone, keyWord } = req.body;
  if (!token) return res.json({ ok: false, error: '缺少 API 密钥' });
  if (!phone) return res.json({ ok: false, error: '缺少手机号' });
  if (!keyWord) return res.json({ ok: false, error: '缺少关键词' });

  proxyToApi('getMsg', { token, phone, keyWord }, (err, data) => {
    if (err) return res.json({ ok: false, error: err.message });
    if (data.startsWith('ERROR:')) return res.json({ ok: false, error: data });
    res.json({ ok: true, data: data.trim() });
  });
});

// 释放号码
app.post('/api/release', (req, res) => {
  const { token, phone } = req.body;
  if (!token) return res.json({ ok: false, error: '缺少 API 密钥' });
  if (!phone) return res.json({ ok: false, error: '缺少手机号' });

  proxyToApi('release', { token, phone }, (err, data) => {
    if (err) return res.json({ ok: false, error: err.message });
    if (data.startsWith('ERROR:')) return res.json({ ok: false, error: data });
    res.json({ ok: true, data: data.trim() });
  });
});

// 拉黑号码
app.post('/api/block', (req, res) => {
  const { token, phone } = req.body;
  if (!token) return res.json({ ok: false, error: '缺少 API 密钥' });
  if (!phone) return res.json({ ok: false, error: '缺少手机号' });

  proxyToApi('block', { token, phone }, (err, data) => {
    if (err) return res.json({ ok: false, error: err.message });
    if (data.startsWith('ERROR:')) return res.json({ ok: false, error: data });
    res.json({ ok: true, data: data.trim() });
  });
});

// ====== 启动 ======
app.listen(PORT, () => {
  console.log('');
  console.log('  🚀 短信验证工具已启动');
  console.log(`  📡 后端地址: http://localhost:${PORT}`);
  console.log(`  🌐 前端页面: http://localhost:${PORT}/`);
  console.log(`  📤 代理目标: ${API_BASE}`);
  console.log('');
});