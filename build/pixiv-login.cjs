'use strict';

/**
 * Pixiv 登录（OAuth PKCE）→ 把 refresh_token 存到本机，供工具调用 app-api 用。
 *
 * 用法（Windows）：
 *   1. 确认代理开着（app-api.pixiv.net 在 Cloudflare 后面，必须走代理）；
 *   2. `D:\node\node.exe D:\ds-download\build\pixiv-login.mjs`
 *   3. 脚本会打印一个登录链接 —— 用浏览器打开、登录 pixiv；
 *   4. 登录后会跳到 `pixiv://account/login?code=xxxx`（页面打不开是正常的），
 *      把地址栏里 `code=` 后面那一串（或整条 URL）粘回命令行，回车；
 *   5. 成功后 token 存在 `%APPDATA%\ds-download\tools\pixiv-token.json`。
 *
 * 凭据来自 pixiv 官方 Android 客户端（与 Pixiv-Shaft 用的同一套）：
 *   client_id / client_secret 是公开的固定值，不是你的账号密码；
 *   真正的凭证是登录后拿到的 refresh_token。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

// ⚠️ 必须是带 DbtuzpyT 的完整 client_id（2026-11-23 实测：短的那版会 403 / 918 无效客户端）
const CLIENT_ID = 'MOBrBDS8blbauoSck0ZfDbtuzpyT';
const CLIENT_SECRET = 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj';
const REDIRECT_URI = 'https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback';
const LOGIN_URL = 'https://app-api.pixiv.net/web/v1/login';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function tokenFile() {
  const base = process.env.APPDATA || process.env.XDG_CONFIG_HOME || require('node:os').homedir();
  return path.join(base, 'ds-download', 'tools', 'pixiv-token.json');
}

async function main() {
  const { request, setHttpProxy } = require('../src/core/http');
  // app-api.pixiv.net 在 Cloudflare 后面，必须走代理：--proxy > 环境变量 > Windows 系统代理
  const flagIdx = process.argv.indexOf('--proxy');
  const fromFlag = flagIdx >= 0 ? String(process.argv[flagIdx + 1] || '').trim() : '';
  const fromEnv = String(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.VIDEOGRAB_PROXY || '').trim();
  const fromSystem = (() => {
    try {
      const { execSync } = require('node:child_process');
      const q = (v) =>
        execSync(`reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ${v}`, { encoding: 'utf8' });
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(q('ProxyEnable'));
      const server = (/ProxyServer\s+REG_SZ\s+(\S+)/i.exec(q('ProxyServer')) || [])[1] || '';
      if (enabled && server) return /^https?:\/\//i.test(server) ? server : `http://${server}`;
    } catch {
      /* 非 Windows / 读不到 */
    }
    return '';
  })();
  const proxy = fromFlag || fromEnv || fromSystem;
  if (proxy) {
    try {
      setHttpProxy(proxy);
      console.log(`ⓘ 使用代理：${proxy}`);
    } catch (err) {
      console.error(`✖ 代理不可用：${err.message}`);
      process.exit(1);
    }
  } else {
    console.log('⚠ 没检测到代理：app-api.pixiv.net 直连会被重置，请先开 Clash 或用 --proxy 指定');
  }

  const verifier = b64url(crypto.randomBytes(48)); // 64 字符
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const url = `${LOGIN_URL}?code_challenge=${challenge}&code_challenge_method=S256&client=pixiv-android`;

  console.log('='.repeat(70));
  console.log('第 1 步：用浏览器打开下面这个链接，登录 pixiv（需要代理）：\n');
  console.log(url);
  console.log('\n第 2 步：登录成功后会跳到 pixiv://account/login?code=…（页面打不开是正常的）');
  console.log('        把地址栏里 code= 后面那一串（或整条 URL）粘贴到这里，回车。');
  console.log('='.repeat(70));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question('\ncode（或整条回调 URL）> ', resolve));
  rl.close();

  const input = String(answer || '').trim();
  const m = /[?&]?code=([A-Za-z0-9_-]+)/.exec(input);
  const code = m ? m[1] : input;
  if (!code) {
    console.error('没读到 code，退出。');
    process.exit(1);
  }

  console.log('\n正在用 code 换 token（走代理）…');
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
    include_policy: 'true',
    get_secure_url: 'true',
  }).toString();

  let json;
  try {
    const res = await request('https://app-api.pixiv.net/auth/token', {
      method: 'POST',
      timeout: 20000,
      retries: 1,
      wantBody: true,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'PixivAndroidApp/5.0.234 (Android 11; Pixel 5)',
        'App-OS': 'android',
        'App-OS-Version': '11',
        'App-Version': '5.0.234',
        Accept: 'application/json',
      },
      body,
    });
    json = JSON.parse((res.body || Buffer.alloc(0)).toString('utf8'));
    if (res.status !== 200 || !json || !json.response) {
      console.error(`换 token 失败（HTTP ${res.status}）：${JSON.stringify(json).slice(0, 300)}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`请求失败：${err.message}`);
    console.error('（app-api.pixiv.net 必须走代理，确认 Clash 开着、系统代理或 --proxy 生效）');
    process.exit(1);
  }

  const r = json.response;
  const file = tokenFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        access_token: r.access_token,
        refresh_token: r.refresh_token,
        expires_in: r.expires_in,
        obtained_at: Date.now(),
        user: r.user ? { id: r.user.id, name: r.user.name, account: r.user.account } : null,
      },
      null,
      2,
    ),
    'utf8',
  );

  console.log('\n✔ 登录成功');
  if (r.user) console.log(`  账号：${r.user.name || ''}（id ${r.user.id}）`);
  console.log(`  token 已保存：${file}`);
  console.log('  access_token 约 1 小时过期，refresh_token 长期有效（工具会自动续）。');
  console.log('\n注意：这是账号凭证。想撤销：pixiv 网页版 → 设置 → 安全 → 登出其他设备。');
}

main().catch((err) => {
  console.error('出错了：', err && err.stack ? err.stack : err);
  process.exit(1);
});
