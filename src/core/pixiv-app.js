'use strict';

/**
 * Pixiv **App API**（`app-api.pixiv.net`）客户端 —— 用登录 token 做「作者名搜索」等
 * 网页接口做不到的事（2026-11-23）。
 *
 * 为什么需要：
 *   · 网页的用户搜索 `/ajax/search/users` 现在连登录态都返回 400，作者名搜不了；
 *   · App API 的 `/v1/search/user?word=名字` 能直接按名字找到画师，再 `/v1/user/illusts`
 *     列作品，比"把名字当标签猜"靠谱得多。
 *
 * token 从哪来：
 *   `%APPDATA%\ds-download\tools\pixiv-token.json`（`build/pixiv-login.cjs` 登录生成，
 *   或从 Pixiv-Shaft 的备份里提取）。access_token 1 小时过期，本模块会用 refresh_token
 *   自动续期并把新 token 写回文件。
 *
 * 凭据（pixiv 官方 Android 客户端，公开固定值）：
 *   client_id = MOBrBDS8blbauoSck0ZfDbtuzpyT
 *   client_secret = lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj
 *   token 端点 = https://oauth.secure.pixiv.net/auth/token
 */

const fs = require('node:fs');
const path = require('node:path');
const { request } = require('./http');

const CLIENT_ID = 'MOBrBDS8blbauoSck0ZfDbtuzpyT';
const CLIENT_SECRET = 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj';
const TOKEN_URL = 'https://oauth.secure.pixiv.net/auth/token';
const API_BASE = 'https://app-api.pixiv.net';
const APP_UA = 'PixivAndroidApp/5.0.234 (Android 11; Pixel 5)';

function tokenFile() {
  const base = process.env.APPDATA || process.env.XDG_CONFIG_HOME || require('node:os').homedir();
  return path.join(base, 'ds-download', 'tools', 'pixiv-token.json');
}

function readToken() {
  try {
    const j = JSON.parse(fs.readFileSync(tokenFile(), 'utf8'));
    return j && j.refresh_token ? j : null;
  } catch {
    return null;
  }
}

function writeToken(tok) {
  try {
    const file = tokenFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(tok, null, 2), 'utf8');
  } catch {
    /* 写不进去不影响本次请求 */
  }
}

/** 有没有可用的登录态（只检查文件存在，不校验有效期） */
function hasToken() {
  return Boolean(readToken());
}

function appHeaders(accessToken) {
  return {
    'User-Agent': APP_UA,
    'App-OS': 'android',
    'App-OS-Version': '11',
    'App-Version': '5.0.234',
    Accept: 'application/json',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Authorization: `Bearer ${accessToken}`,
  };
}

/**
 * 拿一个可用的 access_token：本地没过期就直接用，否则用 refresh_token 换新的。
 * @returns {Promise<string|null>}
 */
async function getAccessToken(opts = {}) {
  const tok = readToken();
  if (!tok) return null;
  const ageMs = Date.now() - Number(tok.obtained_at || 0);
  const ttlMs = (Number(tok.expires_in) || 3600) * 1000;
  if (tok.access_token && ageMs < ttlMs - 60 * 1000) return tok.access_token;
  const onLog = opts.onLog || (() => {});
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: tok.refresh_token,
    include_policy: 'true',
    get_secure_url: 'true',
  }).toString();
  try {
    const res = await request(TOKEN_URL, {
      method: 'POST',
      timeout: opts.timeout || 20000,
      retries: 1,
      wantBody: true,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': APP_UA,
        'App-OS': 'android',
        'App-OS-Version': '11',
        'App-Version': '5.0.234',
        Accept: 'application/json',
      },
      body,
    });
    const j = JSON.parse((res.body || Buffer.alloc(0)).toString('utf8'));
    if (res.status !== 200 || !j.access_token) {
      onLog(`Pixiv 登录态刷新失败（HTTP ${res.status}）：${JSON.stringify(j.message || j.error || j).slice(0, 80)}`);
      return null;
    }
    writeToken({
      access_token: j.access_token,
      refresh_token: j.refresh_token || tok.refresh_token,
      expires_in: j.expires_in,
      obtained_at: Date.now(),
      client_id: CLIENT_ID,
      user: j.user ? { id: j.user.id, name: j.user.name, account: j.user.account } : tok.user || null,
    });
    onLog('Pixiv 登录态已自动续期');
    return j.access_token;
  } catch (err) {
    onLog(`Pixiv 登录态刷新出错：${err.message}`);
    return null;
  }
}

/** 调一次 app-api，返回 JSON（失败抛错） */
async function appGet(pathname, params = {}, opts = {}) {
  const token = opts.accessToken || (await getAccessToken(opts));
  if (!token) throw new Error('没有 Pixiv 登录态（先跑 build/pixiv-login.cjs 或导入备份）');
  const url = new URL(API_BASE + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  /**
   * app-api 在 Cloudflare 后面，经代理时偶发 ECONNRESET（2026-11-23 实测：
   * 同一秒里 `searchUser` 一次成功、一次被重置）。所以这里自己重试 2 次，
   * 别让一次抽风就把「按作者搜」判死刑。
   */
  let res;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      res = await request(url.toString(), {
        timeout: opts.timeout || 15000,
        retries: 0,
        wantBody: true,
        signal: opts.signal,
        headers: appHeaders(token),
      });
      break;
    } catch (err) {
      lastErr = err;
      const msg = String(err && err.message);
      if (!/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|超时|timeout|重置/i.test(msg)) break;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  if (!res) throw lastErr || new Error('Pixiv App API 请求失败');
  const text = (res.body || Buffer.alloc(0)).toString('utf8');
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Pixiv App API 返回非 JSON（HTTP ${res.status}）`);
  }
  if (res.status !== 200 || json.error) {
    throw new Error(`Pixiv App API 失败（HTTP ${res.status}）：${JSON.stringify(json.message || json.error || json).slice(0, 120)}`);
  }
  return json;
}

/** app-api 的 illust → 我们的 item 形状 */
function mapAppIllust(it) {
  const pages = Array.isArray(it.meta_pages) ? it.meta_pages : [];
  const first = pages[0]?.image_urls?.original || it.meta_single_page?.original_image_url || it.image_urls?.large || '';
  const urls = pages.length
    ? pages.map((p) => p?.image_urls?.original || '').filter(Boolean)
    : [first].filter(Boolean);
  return {
    pid: String(it.id || ''),
    title: String(it.title || '').trim() || '（无题）',
    author: String(it.user?.name || '').trim() || '（未知作者）',
    userId: String(it.user?.id || '').trim(),
    tags: Array.isArray(it.tags) ? it.tags.map((t) => String(typeof t === 'string' ? t : t.name || t.tag || '')) : [],
    xRestrict: Number(it.x_restrict) || 0,
    // 原图地址：官方 pximg；下载时会被换到反代/直连
    url: String(first).replace(/^https?:\/\/i\.pximg\.net\//i, 'https://i.pximg.net/'),
    urls,
    pageCount: Number(it.page_count) || urls.length || 0,
    bookmarks: Number(it.total_bookmarks) || 0,
    aiType: Number(it.illust_ai_type) || 0,
    createDate: String(it.create_date || ''),
  };
}

/** 按名字搜画师：`/v1/search/user` → [{userId, userName, account, illusts}] */
async function searchUser(name, opts = {}) {
  const word = String(name || '').trim();
  if (!word) throw new Error('作者名为空');
  const json = await appGet('/v1/search/user', { word, filter: 'for_android' }, opts);
  const previews = Array.isArray(json.user_previews) ? json.user_previews : [];
  const users = previews
    .filter((p) => p && p.user)
    .map((p) => ({
      userId: String(p.user.id || ''),
      userName: String(p.user.name || ''),
      account: String(p.user.account || ''),
      illusts: Array.isArray(p.illusts) ? p.illusts.length : 0,
    }));
  return users;
}

/** 某个画师的作品：`/v1/user/illusts` */
async function userIllusts(userId, opts = {}) {
  const id = String(userId || '').trim();
  if (!/^\d+$/.test(id)) throw new Error(`uid 不合法：${userId}`);
  const want = Math.max(1, Math.min(Number(opts.maxItems) || 500, Number(opts.limit) || 3));
  const json = await appGet(
    '/v1/user/illusts',
    { user_id: id, filter: 'for_android', type: 'illust' },
    opts,
  );
  const list = (Array.isArray(json.illusts) ? json.illusts : []).map(mapAppIllust).filter((x) => x.pid);
  const items = [];
  for (const it of list) {
    if (opts.allowR18 !== true && it.xRestrict > 0) continue;
    items.push(it);
    if (items.length >= want) break;
  }
  return items;
}

/** 作品详情：`/v1/illust/detail`（含多页原图 meta_pages） */
async function illustDetail(pid, opts = {}) {
  const id = String(pid || '').trim();
  if (!/^\d+$/.test(id)) throw new Error(`pid 不合法：${pid}`);
  const json = await appGet('/v1/illust/detail', { illust_id: id }, opts);
  if (!json.illust) throw new Error('作品详情为空（可能已删除或需要登录）');
  return mapAppIllust(json.illust);
}

/** 关键词搜作品：`/v1/search/illust` */
async function searchIllust(word, opts = {}) {
  const kw = String(word || '').trim();
  if (!kw) throw new Error('关键词为空');
  const want = Math.max(1, Math.min(Number(opts.maxItems) || 500, Number(opts.limit) || 3));
  const json = await appGet(
    '/v1/search/illust',
    {
      word: kw,
      search_target: opts.searchTarget || 'partial_match_for_tags',
      sort: opts.sort || 'date_desc',
      filter: 'for_android',
      include_translated_tag_results: 'true',
    },
    opts,
  );
  const list = (Array.isArray(json.illusts) ? json.illusts : []).map(mapAppIllust).filter((x) => x.pid);
  const items = [];
  for (const it of list) {
    if (opts.allowR18 !== true && it.xRestrict > 0) continue;
    items.push(it);
    if (items.length >= want) break;
  }
  return items;
}

module.exports = {
  CLIENT_ID,
  TOKEN_URL,
  tokenFile,
  hasToken,
  getAccessToken,
  appGet,
  mapAppIllust,
  searchUser,
  userIllusts,
  illustDetail,
  searchIllust,
};
