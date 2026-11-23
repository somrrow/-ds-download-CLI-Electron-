'use strict';

/**
 * Pixiv 图片 **免代理直连**（2026-11-23）。
 *
 * 思路来自第三方客户端 Pixiv-Shaft 的实现（`ceui/lisa/http/HttpDns` +
 * `RubySSLSocketFactory` + `TrustAllCertManager`），本文件独立重写：
 *
 *   ① 用 **DoH** 拿 `i.pximg.net` 的真实 IP（普通 DNS 在墙内被污染，
 *      会解析到 199.59.149.232 之类的假地址）；
 *   ② 直连这个 IP，但 **TLS 握手不发送 SNI** —— GFW 靠 SNI 匹配域名做重置，
 *      没有 SNI 就匹配不到；证书校验随之关掉（无 SNI 时证书对不上域名）；
 *   ③ HTTP 里用 `Host: i.pximg.net` 告诉边缘节点要哪个站点。
 *
 * 实测（本机、无代理）：`210.140.139.133` + 无 SNI + Host → HTTP 200，
 * 一张 2.18MB 的原图 1.1~4.5 秒（≈0.5~2MB/s），而走代理只有 30~100KB/s。
 *
 * ⚠️ 只对 **pixiv 自有 IP 的图片 CDN** 有效（i.pximg.net / s.pximg.net）。
 * `app-api.pixiv.net` / `www.pixiv.net` 在 Cloudflare 后面：带 SNI 被重置、
 * 不带 SNI 握手失败、拿 pximg IP 冒充 Host 会 421 —— 搜索/API 仍然必须走代理。
 */

const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const { directFetch } = require('./http');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** DoH 失败时的兜底 IP（实测可用；Pixiv-Shaft 里也硬编码了这几个） */
const FALLBACK_IPS = ['210.140.139.133', '210.140.139.134'];

/** pixiv 图片 CDN 的网段（用来过滤被污染的 DoH 结果） */
const PIXIV_IP_RE = /^210\.140\.\d{1,3}\.\d{1,3}$/;

const DOH_PROVIDERS = [
  (h) => `https://dns.alidns.com/resolve?name=${encodeURIComponent(h)}&type=A`,
  (h) => `https://doh.pub/dns-query?name=${encodeURIComponent(h)}&type=A`,
  (h) => `https://1.0.0.1/dns-query?name=${encodeURIComponent(h)}&type=A`,
  (h) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(h)}&type=A`,
];

function ipCacheFile() {
  const base = process.env.LOCALAPPDATA || process.env.XDG_CACHE_HOME || require('node:os').tmpdir();
  return path.join(base, 'vgrab', 'pixiv-ips.json');
}

function readIpCache() {
  try {
    return JSON.parse(fs.readFileSync(ipCacheFile(), 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeIpCache(data) {
  try {
    const file = ipCacheFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');
  } catch {
    /* 记不住不影响本次 */
  }
}

/**
 * 拿某个 pixiv 图片域名的真实 IP：缓存 → DoH（多个服务商）→ 内置兜底。
 * @returns {Promise<string[]>}
 */
async function resolvePixivIps(host, opts = {}) {
  const name = String(host || '').toLowerCase();
  if (!/\.pximg\.net$/.test(name)) throw new Error(`不是 pixiv 图床域名：${host}`);
  const ttlMs = Number(opts.ttlMs) || 60 * 60 * 1000;
  const cache = readIpCache();
  const hit = cache[name];
  if (hit && Array.isArray(hit.ips) && hit.ips.length && Date.now() - Number(hit.at || 0) < ttlMs) {
    return hit.ips;
  }
  const onLog = opts.onLog || (() => {});
  for (const build of DOH_PROVIDERS) {
    const url = build(name);
    try {
      const text = await (opts.fetchText || require('./http').fetchText)(url, {
        timeout: opts.timeout || 6000,
        retries: 0,
        fetch: directFetch,
        headers: { Accept: 'application/dns-json', 'User-Agent': DEFAULT_UA },
      });
      const json = JSON.parse(text);
      const ips = (json.Answer || [])
        .filter((a) => a && (a.type === 1 || a.type === 28))
        .map((a) => String(a.data || ''))
        .filter((ip) => PIXIV_IP_RE.test(ip));
      if (ips.length) {
        cache[name] = { at: Date.now(), ips };
        writeIpCache(cache);
        onLog(`DoH（${new URL(url).hostname}）解析 ${name} → ${ips.slice(0, 3).join(', ')}`);
        return ips;
      }
    } catch {
      /* 换下一个 DoH */
    }
  }
  onLog(`DoH 全部失败，用内置 IP 兜底：${FALLBACK_IPS.join(', ')}`);
  return FALLBACK_IPS.slice();
}

/** 无 SNI 的 HTTPS GET（只做下载用，支持 chunked / content-length） */
function getWithoutSni({ ip, host, requestPath, headers = {}, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    const t0 = Date.now();
    const sock = tls.connect(
      { host: ip, port: 443, servername: undefined, rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        const lines = [
          `GET ${requestPath} HTTP/1.1`,
          `Host: ${host}`,
          `User-Agent: ${headers['User-Agent'] || DEFAULT_UA}`,
          `Referer: ${headers.Referer || 'https://www.pixiv.net/'}`,
          'Accept: image/avif,image/webp,image/png,image/jpeg,*/*',
          'Accept-Encoding: identity',
          'Connection: close',
          '',
          '',
        ];
        sock.write(lines.join('\r\n'));
      },
    );
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      // 早失败：421/403/404 这类不用等整个 body
      if (buf.length > 12) {
        const head = buf.slice(0, Math.min(buf.length, 200)).toString('latin1');
        const m = /^HTTP\/1\.[01] (\d{3})/.exec(head);
        if (m && m[1] !== '200' && m[1] !== '206') {
          const headEnd = head.indexOf('\r\n\r\n');
          if (headEnd >= 0) {
            sock.destroy();
            done(resolve, { status: Number(m[1]), headers: {}, body: Buffer.alloc(0), ms: Date.now() - t0, ip });
          }
        }
      }
    });
    const finish = () => {
      const text = buf.toString('latin1');
      const headEnd = text.indexOf('\r\n\r\n');
      if (headEnd < 0) {
        done(resolve, { status: 0, headers: {}, body: Buffer.alloc(0), ms: Date.now() - t0, ip });
        return;
      }
      const headText = text.slice(0, headEnd);
      const status = Number((/^HTTP\/1\.[01] (\d{3})/.exec(headText) || [])[1]) || 0;
      const hdrs = {};
      for (const line of headText.split('\r\n').slice(1)) {
        const i = line.indexOf(':');
        if (i > 0) hdrs[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      let body = buf.slice(headEnd + 4);
      if (/chunked/i.test(hdrs['transfer-encoding'] || '')) {
        const chunks = [];
        let rest = body;
        for (;;) {
          const nl = rest.indexOf('\r\n');
          if (nl < 0) break;
          const size = parseInt(rest.slice(0, nl).toString('latin1'), 16);
          if (!Number.isFinite(size) || size <= 0) break;
          chunks.push(rest.slice(nl + 2, nl + 2 + size));
          rest = rest.slice(nl + 2 + size + 2);
        }
        body = Buffer.concat(chunks);
      } else if (hdrs['content-length']) {
        const len = Number(hdrs['content-length']);
        if (Number.isFinite(len) && body.length > len) body = body.slice(0, len);
      }
      done(resolve, { status, headers: hdrs, body, ms: Date.now() - t0, ip });
    };
    sock.on('end', finish);
    sock.on('close', finish);
    sock.on('error', (err) => done(reject, err));
    sock.on('timeout', () => {
      sock.destroy();
      done(reject, new Error(`直连 ${ip} 超时（${timeoutMs}ms）`));
    });
  });
}

function extFromContentType(ct, fallback = '.jpg') {
  const t = String(ct || '').toLowerCase();
  if (t.includes('png')) return '.png';
  if (t.includes('gif')) return '.gif';
  if (t.includes('webp')) return '.webp';
  if (t.includes('jpeg') || t.includes('jpg')) return '.jpg';
  return fallback;
}

/**
 * 把一批 **原图路径**（`/img-original/img/.../xxx_p0.jpg`）免代理下到 outDir。
 * @param {string[]} paths
 * @param {{ outDir:string, host?:string, onLog?:Function, timeout?:number, signal?:AbortSignal }} opts
 * @returns {Promise<{files:string[], bytes:number, ips:string[]}>}
 */
/**
 * 给候选 IP **快速测速**（Range 取 64KB，6 秒截止），按吞吐排序。
 * 抖音式的多 IP 里经常有一两个特别慢的（实测 210.140.139.135 有时 14 秒、
 * 有时 1 秒），先测一下能省十几秒。
 */
async function rankIps(ips, host, samplePath, opts = {}) {
  const onLog = opts.onLog || (() => {});
  const results = await Promise.all(
    ips.map(async (ip) => {
      const t0 = Date.now();
      try {
        const res = await getWithoutSni({
          ip,
          host,
          requestPath: samplePath,
          timeoutMs: opts.probeTimeout || 6000,
          headers: { ...(opts.headers || {}), Range: 'bytes=0-65535' },
        });
        const ms = Math.max(1, Date.now() - t0);
        const bytes = res.body ? res.body.length : 0;
        if (res.status !== 200 && res.status !== 206) return { ip, ok: false, rate: 0, ms };
        return { ip, ok: bytes > 1024, rate: bytes / ms, ms, bytes };
      } catch {
        return { ip, ok: false, rate: 0, ms: Date.now() - t0 };
      }
    }),
  );
  results.sort((a, b) => (b.ok - a.ok) || (b.rate - a.rate));
  const usable = results.filter((r) => r.ok);
  if (usable.length) {
    onLog('直连测速：' + usable.map((r) => `${r.ip} ${Math.round(r.rate)}KB/s`).join('，'));
  }
  return [...usable.map((r) => r.ip), ...results.filter((r) => !r.ok).map((r) => r.ip)];
}
async function downloadPixivPathsDirect(paths, opts = {}) {
  const list = (Array.isArray(paths) ? paths : []).filter(Boolean);
  if (!list.length) throw new Error('没有可下载的原图路径');
  const host = String(opts.host || 'i.pximg.net');
  const onLog = opts.onLog || (() => {});
  const outDir = opts.outDir || process.cwd();
  fs.mkdirSync(outDir, { recursive: true });
  const resolved = await resolvePixivIps(host, { onLog, timeout: opts.timeout, fetchText: opts.fetchText });
  const ips = resolved.length > 1 ? await rankIps(resolved, host, list[0], { ...opts, onLog }) : resolved;
  const used = [];
  const files = [];
  let bytes = 0;
  for (const [index, p] of list.entries()) {
    if (opts.signal && opts.signal.aborted) throw new Error('已取消');
    let ok = false;
    let lastErr = null;
    for (const ip of ips) {
      try {
        const res = await getWithoutSni({
          ip,
          host,
          requestPath: p,
          timeoutMs: opts.timeout || 20000,
          headers: opts.headers || {},
        });
        if (res.status !== 200 && res.status !== 206) {
          lastErr = new Error(`HTTP ${res.status || '?'}（${ip}）`);
          continue;
        }
        if (!res.body.length || res.body.length < 1024) {
          lastErr = new Error(`返回内容太小（${res.body.length}B）`);
          continue;
        }
        const ext = extFromContentType(res.headers['content-type'], path.extname(p) || '.jpg');
        const file = path.join(outDir, `${String(index + 1).padStart(3, '0')}${ext}`);
        fs.writeFileSync(file, res.body);
        files.push(file);
        bytes += res.body.length;
        if (!used.includes(ip)) used.push(ip);
        onLog(`直连 ${host}@${ip}：第 ${index + 1}/${list.length} 张 ${(res.body.length / 1024 / 1024).toFixed(1)}MB / ${res.ms}ms`);
        ok = true;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!ok) throw new Error(`免代理直连失败（${list.length} 张里第 ${index + 1} 张）：${lastErr ? lastErr.message : '未知'}`);
  }
  return { files, bytes, ips: used.length ? used : ips };
}

module.exports = {
  FALLBACK_IPS,
  PIXIV_IP_RE,
  DOH_PROVIDERS,
  resolvePixivIps,
  getWithoutSni,
  downloadPixivPathsDirect,
};
