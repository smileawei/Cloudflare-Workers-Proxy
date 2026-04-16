addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

const ROUTES_KV_KEY = 'routes';
const ADMIN_API_PREFIX = '/admin/api';

// 从 KV 加载路由
async function loadRoutes() {
  if (typeof ROUTES_KV !== 'undefined') {
    try {
      const routes = await ROUTES_KV.get(ROUTES_KV_KEY, 'json');
      return isPlainObject(routes) ? routes : {};
    } catch (_) {}
  }
  return {};
}

// 保存路由到 KV
async function saveRoutes(routes) {
  if (typeof ROUTES_KV === 'undefined') {
    throw new Error('KV namespace ROUTES_KV not bound');
  }
  await ROUTES_KV.put(ROUTES_KV_KEY, JSON.stringify(routes));
}

// 验证管理员密码

function checkAuth(request) {
  const password = typeof ADMIN_PASSWORD !== 'undefined' ? ADMIN_PASSWORD : '';
  if (!password) return false;
  const token = request.headers.get('X-Admin-Token');
  return token === password;
}

async function handleRequest(request) {
  try {
    const url = new URL(request.url);

    // 管理后台路由
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      return new Response(getAdminHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    if (url.pathname === ADMIN_API_PREFIX || url.pathname.startsWith(ADMIN_API_PREFIX + '/')) {
      return handleAdminApi(request, url);
    }

    const routes = await loadRoutes();

    // 根路径返回可用路由列表
    if (url.pathname === '/' || url.pathname === '') {
      return new Response(getRootHtml(routes), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // 匹配路由前缀
    const match = matchRoute(url.pathname, routes);
    if (!match) {
      return jsonResponse({ error: 'Route not found' }, 404);
    }

    const { prefix, target } = match;

    const remaining = url.pathname.slice(prefix.length);
    const actualUrlStr = buildTargetUrl(target, remaining, url.search);

    const newHeaders = filterHeaders(request.headers, name => !name.startsWith('cf-') && name !== 'host');

    const modifiedRequest = new Request(actualUrlStr, {
      headers: newHeaders,
      method: request.method,
      body: request.body,
      redirect: 'manual',
    });

    const response = await fetch(modifiedRequest);
    let body = response.body;

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      return handleRedirect(response, prefix, target);
    } else if (response.headers.get('Content-Type')?.includes('text/html')) {
      body = await handleHtmlContent(response, prefix);
    }

    const modifiedResponse = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });

    setNoCacheHeaders(modifiedResponse.headers);
    setCorsHeaders(modifiedResponse.headers);

    return modifiedResponse;
  } catch (error) {
    return jsonResponse({ error: error.message }, 500);
  }
}

// 管理 API
async function handleAdminApi(request, url) {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (!checkAuth(request)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const path = url.pathname.replace(ADMIN_API_PREFIX, '') || '/';

  if (path === '/routes' && request.method === 'GET') {
    const routes = await loadRoutes();
    return jsonResponse({ routes }, 200);
  }

  if (path === '/routes' && request.method === 'POST') {
    const payload = await readJson(request);
    const normalized = normalizeRouteInput(payload);
    if ('error' in normalized) {
      return jsonResponse({ error: normalized.error }, 400);
    }

    const { prefix, target } = normalized;
    if (!prefix || !target) {
      return jsonResponse({ error: 'prefix and target are required' }, 400);
    }

    const routes = await loadRoutes();
    routes[prefix] = target;
    await saveRoutes(routes);
    return jsonResponse({ ok: true, routes }, 200);
  }

  if (path === '/routes' && request.method === 'DELETE') {
    const payload = await readJson(request);
    const prefix = normalizePrefix(payload?.prefix);
    if (!prefix || prefix === '/') {
      return jsonResponse({ error: 'valid prefix is required' }, 400);
    }
    const routes = await loadRoutes();
    delete routes[prefix];
    await saveRoutes(routes);
    return jsonResponse({ ok: true, routes }, 200);
  }

  if (path === '/check' && request.method === 'GET') {
    return jsonResponse({ ok: true }, 200);
  }

  return jsonResponse({ error: 'Not found' }, 404);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
  };
}

// 按最长前缀匹配路由
function matchRoute(pathname, routes) {
  let best = null;
  for (const prefix of Object.keys(routes)) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) {
      if (!best || prefix.length > best.prefix.length) {
        best = { prefix, target: routes[prefix] };
      }
    }
  }
  return best;
}

function buildTargetUrl(target, remainingPath, search) {
  const base = new URL(target);
  const normalizedRemaining = remainingPath || '';

  if (normalizedRemaining) {
    base.pathname = joinUrlPaths(base.pathname, normalizedRemaining);
  }

  base.search = search || '';
  return base.toString();
}

function joinUrlPaths(basePath, appendedPath) {
  const left = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  const right = appendedPath.startsWith('/') ? appendedPath : `/${appendedPath}`;
  return `${left}${right}` || '/';
}

function handleRedirect(response, prefix, target) {
  const location = response.headers.get('location');
  if (!location) return response;

  let modifiedLocation = location;
  try {
    const locUrl = new URL(location, target);
    if (locUrl.origin === new URL(target).origin) {
      modifiedLocation = mapLocationToProxyPath(locUrl, prefix, target);
    }
  } catch (_) {}

  const headers = new Headers(response.headers);
  headers.set('Location', modifiedLocation);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function handleHtmlContent(response, prefix) {
  const originalText = await response.text();
  const normalizedPrefix = prefix === '/' ? '' : prefix;
  const regex = /((?:href|src|action)=["'])\/(?!\/)/gi;
  return originalText.replace(regex, `$1${normalizedPrefix}/`);
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
    },
  });
}

function filterHeaders(headers, filterFunc) {
  return new Headers([...headers].filter(([name]) => filterFunc(name)));
}

function setNoCacheHeaders(headers) {
  headers.set('Cache-Control', 'no-store');
}

function setCorsHeaders(headers) {
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizePrefix(input) {
  if (typeof input !== 'string') return '';

  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return '';
  if (trimmed.includes('://')) return '';

  const collapsed = trimmed.replace(/\/{2,}/g, '/');
  if (collapsed === '/') return '/';
  return collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
}

function normalizeTarget(input) {
  if (typeof input !== 'string') return '';

  const trimmed = input.trim();
  if (!trimmed) return '';

  try {
    const url = new URL(trimmed);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    return url.toString().replace(/\/$/, url.pathname === '/' ? '' : '/');
  } catch (_) {
    return '';
  }
}

function normalizeRouteInput(payload) {
  const prefix = normalizePrefix(payload?.prefix);
  const target = normalizeTarget(payload?.target);

  if (!prefix) {
    return { error: 'prefix must start with / and be a valid path' };
  }

  if (prefix === '/admin' || prefix.startsWith('/admin/')) {
    return { error: 'prefix cannot use the reserved /admin path' };
  }

  if (!target) {
    return { error: 'target must be a valid http(s) URL' };
  }

  return { prefix, target };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (_) {
    return null;
  }
}

function mapLocationToProxyPath(locUrl, prefix, target) {
  const targetUrl = new URL(target);
  const targetPath = targetUrl.pathname === '/' ? '' : targetUrl.pathname.replace(/\/$/, '');
  let remainder = locUrl.pathname;

  if (targetPath && remainder.startsWith(targetPath + '/')) {
    remainder = remainder.slice(targetPath.length);
  } else if (targetPath && remainder === targetPath) {
    remainder = '';
  }

  return `${prefix}${remainder}${locUrl.search}${locUrl.hash}` || '/';
}

function groupRoutes(routes) {
  const rootItems = [];
  const groups = {};
  for (const prefix of Object.keys(routes)) {
    const segments = prefix.split('/').filter(Boolean);
    if (segments.length <= 1) {
      rootItems.push(prefix);
    } else {
      (groups[segments[0]] ||= []).push(prefix);
    }
  }
  return { rootItems, groups };
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderRoutesList(routes) {
  const { rootItems, groups } = groupRoutes(routes);
  const liFor = p => {
    const safe = escapeHtml(p);
    return `<li><a href="${safe}"><code>${safe}</code></a></li>`;
  };

  const rootHtml = rootItems.map(liFor).join('');

  const groupsHtml = Object.entries(groups)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, items]) => {
      const inner = items.sort().map(liFor).join('');
      return `<li class="group"><details><summary>${escapeHtml(name)}/</summary><ul>${inner}</ul></details></li>`;
    })
    .join('');

  if (!rootHtml && !groupsHtml) {
    return '<div class="empty-state">No routes configured yet</div>';
  }

  return `<ul>${rootHtml}${groupsHtml}</ul>`;
}

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none"><style>.a{fill:#2c3e50}@media(prefers-color-scheme:dark){.a{fill:#e0e0e0}}</style><path class="a" d="M16 54 L46 54 L46 42 L66 64 L46 86 L46 74 L16 74 Z"/><ellipse cx="68" cy="64" rx="6" ry="28" stroke="#14b8a6" stroke-width="5" stroke-opacity="0.55"/><ellipse cx="56" cy="64" rx="6" ry="28" stroke="#14b8a6" stroke-width="5"/><path class="a" d="M78 58 L88 58 L88 48 L104 64 L88 80 L88 70 L78 70 Z"/></svg>`;

function getRootHtml(routes) {
  const routesHtml = renderRoutesList(routes);
  const favicon = `data:image/svg+xml,${encodeURIComponent(LOGO_SVG)}`;
  const routeCount = Object.keys(routes).length;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Warp</title>
  <link rel="icon" type="image/svg+xml" href="${favicon}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
      :root {
          --bg: #07111d;
          --card: rgba(8, 19, 31, 0.76);
          --line: rgba(162, 184, 206, 0.18);
          --text: #f3f7fb;
          --muted: #9db0c5;
          --accent: #5eead4;
          --mono: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
      }
      *, *::before, *::after { box-sizing: border-box; }
      html, body { min-height: 100%; margin: 0; }
      body {
          font-family: 'Space Grotesk', 'Segoe UI', sans-serif;
          color: var(--text);
          background:
            radial-gradient(circle at 12% 18%, rgba(94,234,212,0.18), transparent 28%),
            radial-gradient(circle at 84% 12%, rgba(34,197,94,0.16), transparent 24%),
            radial-gradient(circle at 50% 120%, rgba(59,130,246,0.18), transparent 42%),
            linear-gradient(160deg, #06101a 0%, #091828 46%, #07111d 100%);
      }
      body::before {
          content: '';
          position: fixed;
          inset: 0;
          pointer-events: none;
          background-image:
            linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px);
          background-size: 32px 32px;
          mask-image: radial-gradient(circle at center, black 38%, transparent 88%);
          opacity: 0.3;
      }
      .wrap {
          min-height: 100vh;
          padding: 40px 24px;
          display: flex;
          align-items: center;
          justify-content: center;
      }
      .shell {
          width: min(1080px, 100%);
          display: grid;
          grid-template-columns: 1.05fr 0.95fr;
          gap: 24px;
          align-items: stretch;
      }
      .hero, .panel {
          position: relative;
          overflow: hidden;
          border: 1px solid var(--line);
          border-radius: 28px;
          background: var(--card);
          backdrop-filter: blur(24px);
          -webkit-backdrop-filter: blur(24px);
          box-shadow: 0 22px 70px rgba(0, 0, 0, 0.32);
      }
      .hero {
          padding: 34px;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          min-height: 620px;
      }
      .hero::after, .panel::after {
          content: '';
          position: absolute;
          inset: auto -80px -120px auto;
          width: 240px;
          height: 240px;
          border-radius: 50%;
          background: radial-gradient(circle, rgba(94,234,212,0.22) 0%, transparent 72%);
          pointer-events: none;
      }
      .eyebrow {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          padding: 10px 14px;
          border-radius: 999px;
          border: 1px solid rgba(94,234,212,0.2);
          background: rgba(255,255,255,0.04);
          color: var(--accent);
          font-size: 0.82rem;
          letter-spacing: 0.12em;
          text-transform: uppercase;
      }
      .eyebrow::before {
          content: '';
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: currentColor;
          box-shadow: 0 0 0 8px rgba(94,234,212,0.12);
      }
      .brand {
          display: flex;
          align-items: center;
          gap: 16px;
          margin-top: 18px;
      }
      .brand-mark {
          width: 74px;
          height: 74px;
          padding: 14px;
          display: grid;
          place-items: center;
          border-radius: 22px;
          background: linear-gradient(145deg, rgba(255,255,255,0.16), rgba(255,255,255,0.04));
          border: 1px solid rgba(255,255,255,0.12);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 14px 30px rgba(0,0,0,0.22);
      }
      .brand-mark svg { width: 100%; height: 100%; }
      .brand-meta strong {
          display: block;
          font-size: clamp(2rem, 4vw, 3.4rem);
          line-height: 0.95;
          letter-spacing: -0.05em;
      }
      .brand-meta span {
          display: block;
          margin-top: 8px;
          color: var(--muted);
          font-size: 0.96rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
      }
      .hero-copy h1 {
          margin: 20px 0 14px;
          max-width: 11ch;
          font-size: clamp(2.2rem, 5vw, 4.8rem);
          line-height: 0.95;
          letter-spacing: -0.06em;
      }
      .hero-copy p {
          margin: 0;
          max-width: 42ch;
          color: var(--muted);
          font-size: 1.02rem;
          line-height: 1.65;
      }
      .hero-stats {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 14px;
          margin-top: 28px;
      }
      .stat {
          padding: 16px 18px;
          border-radius: 18px;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.08);
      }
      .stat strong {
          display: block;
          font-size: 1.6rem;
          letter-spacing: -0.05em;
      }
      .stat span {
          display: block;
          margin-top: 6px;
          color: var(--muted);
          font-size: 0.82rem;
          text-transform: uppercase;
          letter-spacing: 0.1em;
      }
      .hero-note {
          margin-top: 24px;
          padding: 18px 20px;
          border-radius: 22px;
          background: linear-gradient(140deg, rgba(94,234,212,0.12), rgba(255,255,255,0.04));
          border: 1px solid rgba(94,234,212,0.16);
          color: #d9f7f1;
          line-height: 1.6;
      }
      .panel {
          padding: 26px;
      }
      .panel-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          margin-bottom: 20px;
      }
      .panel-head h2 {
          margin: 0;
          font-size: 1.25rem;
          letter-spacing: -0.03em;
      }
      .panel-head p {
          margin: 4px 0 0;
          color: var(--muted);
          font-size: 0.92rem;
      }
      .pill {
          padding: 9px 12px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(255,255,255,0.05);
          color: var(--text);
          font-size: 0.82rem;
      }
      .empty-state {
          padding: 28px 18px;
          border-radius: 20px;
          border: 1px dashed rgba(255,255,255,0.14);
          background: rgba(255,255,255,0.03);
          text-align: center;
          color: var(--muted);
          line-height: 1.7;
      }
      ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px; }
      li a, .group summary {
          display: flex;
          align-items: center;
          width: 100%;
          min-height: 60px;
          padding: 14px 16px;
          border-radius: 18px;
          border: 1px solid rgba(255,255,255,0.08);
          background: rgba(255,255,255,0.04);
          color: inherit;
          text-decoration: none;
          transition: transform 0.18s ease, border-color 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
      }
      li a:hover, .group summary:hover {
          transform: translateY(-2px);
          border-color: rgba(94,234,212,0.28);
          background: rgba(94,234,212,0.09);
          box-shadow: 0 10px 24px rgba(0,0,0,0.16);
      }
      li a::before {
          content: '↗';
          display: inline-grid;
          place-items: center;
          width: 34px;
          height: 34px;
          margin-right: 12px;
          border-radius: 12px;
          background: rgba(94,234,212,0.12);
          color: var(--accent);
          font-size: 0.95rem;
      }
      li a code {
          background: none;
          padding: 0;
          font-size: 0.94rem;
          color: #eff8ff;
          font-family: var(--mono);
      }
      .group summary {
          cursor: pointer;
          color: #dce7f2;
          user-select: none;
          list-style: none;
      }
      .group summary::-webkit-details-marker { display: none; }
      .group summary::before {
          content: '';
          width: 8px;
          height: 8px;
          margin-right: 14px;
          border-right: 2px solid currentColor;
          border-bottom: 2px solid currentColor;
          transform: rotate(-45deg);
          transition: transform 0.18s ease;
      }
      .group summary::after {
          content: 'Group';
          margin-left: auto;
          color: var(--muted);
          font-size: 0.74rem;
          letter-spacing: 0.12em;
          text-transform: uppercase;
      }
      .group details[open] summary::before { transform: rotate(45deg); }
      .group details ul {
          margin-top: 10px;
          padding-left: 14px;
          border-left: 1px solid rgba(255,255,255,0.08);
      }
      @media (max-width: 920px) {
          .shell { grid-template-columns: 1fr; }
          .hero { min-height: auto; }
      }
      @media (max-width: 640px) {
          .wrap { padding: 20px 14px; }
          .hero, .panel { padding: 22px; border-radius: 24px; }
          .brand { align-items: flex-start; }
          .brand-meta strong { font-size: 2rem; }
          .hero-stats { grid-template-columns: 1fr; }
      }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="shell">
      <section class="hero">
        <div>
          <div class="eyebrow">Edge Proxy Control</div>
          <div class="hero-copy">
            <div class="brand">
              <div class="brand-mark">${LOGO_SVG}</div>
              <div class="brand-meta">
                <strong>Warp</strong>
                <span>Cloudflare Route Fabric</span>
              </div>
            </div>
            <h1>Proxy routes with a cleaner edge surface.</h1>
            <p>Browse active prefixes, jump straight into routed endpoints, and keep the public landing page looking more like a control plane than a placeholder.</p>
          </div>
          <div class="hero-stats">
            <div class="stat">
              <strong>${routeCount}</strong>
              <span>Active Routes</span>
            </div>
            <div class="stat">
              <strong>KV</strong>
              <span>Backed Config</span>
            </div>
            <div class="stat">
              <strong>/admin</strong>
              <span>Console Entry</span>
            </div>
          </div>
        </div>
        <div class="hero-note">
          Routes are matched by longest prefix first. Use the admin console to add, replace, or remove upstream mappings without editing code.
        </div>
      </section>
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Published Prefixes</h2>
            <p>Choose a route to open its proxied upstream.</p>
          </div>
          <div class="pill">${routeCount} route${routeCount === 1 ? '' : 's'}</div>
        </div>
        ${routesHtml}
      </section>
    </div>
  </div>
</body>
</html>`;
}

// ========== 管理后台 HTML ==========
function getAdminHtml() {
  const favicon = `data:image/svg+xml,${encodeURIComponent(LOGO_SVG)}`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Warp Admin</title>
  <link rel="icon" type="image/svg+xml" href="${favicon}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --card: rgba(8, 18, 30, 0.8);
      --line: rgba(160, 181, 203, 0.16);
      --text: #f3f7fb;
      --muted: #96abc0;
      --accent: #5eead4;
      --danger: #fb7185;
      --mono: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
    }
    *, *::before, *::after { box-sizing: border-box; }
    html, body { min-height: 100%; margin: 0; }
    body {
      font-family: 'Space Grotesk', 'Segoe UI', sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at 10% 10%, rgba(94,234,212,0.16), transparent 28%),
        radial-gradient(circle at 92% 18%, rgba(59,130,246,0.16), transparent 24%),
        linear-gradient(160deg, #050c14 0%, #0a1320 44%, #08101a 100%);
    }
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      pointer-events: none;
      background:
        linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px);
      background-size: 32px 32px;
      mask-image: radial-gradient(circle at center, black 34%, transparent 82%);
      opacity: 0.32;
    }
    .wrap {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 28px;
    }
    .layout {
      width: min(1200px, 100%);
      display: grid;
      grid-template-columns: 320px minmax(0, 1fr);
      gap: 22px;
      align-items: start;
    }
    .rail, .card {
      position: relative;
      overflow: hidden;
      border-radius: 28px;
      border: 1px solid var(--line);
      background: var(--card);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      box-shadow: 0 24px 70px rgba(0,0,0,0.32);
    }
    .rail {
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      min-height: 720px;
    }
    .card {
      padding: 24px;
      min-height: 720px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .brand-mark {
      width: 62px;
      height: 62px;
      display: grid;
      place-items: center;
      padding: 12px;
      border-radius: 18px;
      background: linear-gradient(145deg, rgba(255,255,255,0.14), rgba(255,255,255,0.04));
      border: 1px solid rgba(255,255,255,0.1);
    }
    .brand-mark svg { width: 100%; height: 100%; }
    .brand-copy strong {
      display: block;
      font-size: 1.55rem;
      letter-spacing: -0.04em;
    }
    .brand-copy span {
      display: block;
      margin-top: 5px;
      color: var(--muted);
      font-size: 0.82rem;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }
    .rail-badge {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      width: fit-content;
      padding: 10px 14px;
      border-radius: 999px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(94,234,212,0.22);
      color: var(--accent);
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.12em;
    }
    .rail-badge::before {
      content: '';
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: currentColor;
      box-shadow: 0 0 0 8px rgba(94,234,212,0.12);
    }
    .rail h1 {
      margin: 0;
      font-size: clamp(2rem, 4vw, 3rem);
      line-height: 0.96;
      letter-spacing: -0.06em;
    }
    .rail p, .section-copy {
      margin: 0;
      color: var(--muted);
      line-height: 1.7;
      font-size: 0.98rem;
    }
    .rail-stats {
      display: grid;
      gap: 12px;
      margin-top: auto;
    }
    .stat-box, .metric {
      padding: 16px;
      border-radius: 20px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
    }
    .stat-box strong, .metric strong {
      display: block;
      font-size: 1.45rem;
      letter-spacing: -0.04em;
    }
    .stat-box span, .metric span {
      display: block;
      margin-top: 6px;
      color: var(--muted);
      font-size: 0.78rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .surface {
      display: flex;
      flex-direction: column;
      gap: 24px;
      height: 100%;
    }
    .panel {
      border-radius: 24px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03);
      padding: 22px;
    }
    .login-shell {
      max-width: 520px;
      margin: auto;
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .login-shell .title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    h2 {
      margin: 0;
      font-size: 1.3rem;
      letter-spacing: -0.04em;
      color: var(--text);
    }
    .mini-pill {
      padding: 8px 11px;
      border-radius: 999px;
      background: rgba(94,234,212,0.08);
      border: 1px solid rgba(94,234,212,0.2);
      color: var(--accent);
      font-size: 0.78rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .field-label {
      display: block;
      margin-bottom: 8px;
      color: #dbe8f4;
      font-size: 0.84rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .text-input {
      width: 100%;
      min-height: 52px;
      padding: 14px 16px;
      border-radius: 16px;
      border: 1px solid rgba(255,255,255,0.1);
      background: rgba(255,255,255,0.04);
      color: var(--text);
      outline: none;
      font: inherit;
      transition: border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
    }
    .text-input::placeholder { color: #7290ad; }
    .text-input:focus {
      border-color: rgba(94,234,212,0.32);
      box-shadow: 0 0 0 4px rgba(94,234,212,0.1);
      background: rgba(255,255,255,0.06);
    }
    .btn {
      min-height: 46px;
      padding: 0 16px;
      border: none;
      border-radius: 14px;
      cursor: pointer;
      font: inherit;
      font-size: 0.9rem;
      font-weight: 600;
      transition: transform 0.16s ease, box-shadow 0.16s ease, background 0.16s ease;
    }
    .btn:hover { transform: translateY(-1px); }
    .btn-primary {
      color: #042018;
      background: linear-gradient(135deg, #5eead4, #86efac);
      box-shadow: 0 12px 28px rgba(94,234,212,0.18);
    }
    .btn-ghost {
      color: var(--muted);
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.1);
    }
    .btn-edit {
      color: var(--accent);
      background: rgba(94,234,212,0.08);
      border: 1px solid rgba(94,234,212,0.18);
    }
    .btn-danger {
      color: #ffdce2;
      background: rgba(251,113,133,0.1);
      border: 1px solid rgba(251,113,133,0.16);
    }
    .btn-sm {
      min-height: 38px;
      padding: 0 13px;
      border-radius: 12px;
      font-size: 0.82rem;
    }
    #admin-section { display: none; }
    .admin-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 20px;
    }
    .admin-meta {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    .routes-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .route-card {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 16px 18px;
      border-radius: 20px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.035);
      transition: transform 0.16s ease, border-color 0.16s ease, background 0.16s ease;
    }
    .route-card:hover {
      transform: translateY(-2px);
      border-color: rgba(94,234,212,0.22);
      background: rgba(94,234,212,0.06);
    }
    .route-icon {
      width: 44px;
      height: 44px;
      display: grid;
      place-items: center;
      border-radius: 14px;
      background: rgba(94,234,212,0.1);
      color: var(--accent);
      font-size: 1rem;
      flex: 0 0 auto;
    }
    .route-info { flex: 1; min-width: 0; }
    .route-path {
      font-family: var(--mono);
      font-size: 0.94rem;
      font-weight: 700;
      color: #ecfdf5;
    }
    .route-target {
      margin-top: 5px;
      color: var(--muted);
      font-size: 0.84rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .route-actions {
      display: flex;
      gap: 8px;
      flex-shrink: 0;
    }
    .empty-msg {
      padding: 34px 20px;
      border-radius: 22px;
      border: 1px dashed rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.03);
      color: var(--muted);
      text-align: center;
      line-height: 1.7;
    }
    .add-form { display: grid; gap: 16px; }
    .form-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    .form-actions {
      display: flex;
      justify-content: flex-end;
    }
    .toast {
      position: fixed;
      left: 50%;
      bottom: 28px;
      transform: translateX(-50%) translateY(10px);
      padding: 13px 18px;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(9,20,32,0.92);
      color: var(--text);
      box-shadow: 0 18px 36px rgba(0,0,0,0.28);
      opacity: 0;
      transition: opacity 0.25s ease, transform 0.25s ease;
      pointer-events: none;
      z-index: 99;
    }
    .toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    @media (max-width: 980px) {
      .layout { grid-template-columns: 1fr; }
      .rail, .card { min-height: auto; }
      .rail-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
    @media (max-width: 720px) {
      .wrap { padding: 16px; }
      .rail, .card { padding: 18px; border-radius: 24px; }
      .admin-header { flex-direction: column; }
      .admin-meta, .form-grid, .rail-stats { grid-template-columns: 1fr; }
      .route-card { flex-direction: column; align-items: flex-start; }
      .route-actions { width: 100%; justify-content: flex-end; }
      .login-shell .title { flex-direction: column; align-items: flex-start; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="layout">
      <aside class="rail">
        <div class="rail-badge">Admin Console</div>
        <div class="brand">
          <div class="brand-mark">${LOGO_SVG}</div>
          <div class="brand-copy">
            <strong>Warp</strong>
            <span>Routing Surface</span>
          </div>
        </div>
        <h1>Operate routes like a small edge control plane.</h1>
        <p>Manage prefix mappings, verify login state, and keep the proxy surface coherent without dropping into code for every route change.</p>
        <div class="rail-stats">
          <div class="stat-box">
            <strong id="stat-routes">0</strong>
            <span>Routes Loaded</span>
          </div>
          <div class="stat-box">
            <strong>KV</strong>
            <span>Persistent Store</span>
          </div>
          <div class="stat-box">
            <strong>Live</strong>
            <span>Edge Updates</span>
          </div>
        </div>
      </aside>
      <main class="card">
        <div class="surface">
          <div id="login-section" class="login-shell">
            <div class="title">
              <div>
                <h2>Unlock Admin Access</h2>
                <p class="section-copy">Authenticate with the configured admin password to view and modify route mappings.</p>
              </div>
              <div class="mini-pill">Protected</div>
            </div>
            <div class="panel">
              <label class="field-label" for="password-input">Admin Password</label>
              <input class="text-input" type="password" id="password-input" placeholder="Enter admin password" autofocus>
              <div style="margin-top:14px">
                <button class="btn btn-primary" onclick="doLogin()" style="width:100%">Enter Console</button>
              </div>
            </div>
          </div>

          <div id="admin-section">
            <div class="admin-header">
              <div>
                <h2>Route Management</h2>
                <p class="section-copy">Review active route prefixes, adjust upstream targets, and publish changes instantly.</p>
              </div>
              <button class="btn btn-ghost btn-sm" onclick="doLogout()">Logout</button>
            </div>
            <div class="admin-meta">
              <div class="metric">
                <strong id="meta-route-count">0</strong>
                <span>Total Routes</span>
              </div>
              <div class="metric">
                <strong>Prefix</strong>
                <span>Longest Match</span>
              </div>
              <div class="metric">
                <strong>/admin</strong>
                <span>Secure Entry</span>
              </div>
            </div>
            <div class="panel">
              <div id="routes-list"></div>
            </div>
            <div class="panel">
              <div style="margin-bottom:16px">
                <h2 style="font-size:1.05rem">Add or Replace Route</h2>
                <p class="section-copy">Use a prefix like <code style="font-family:var(--mono)">/api</code> and a full upstream URL.</p>
              </div>
              <div class="add-form">
                <div class="form-grid">
                  <div>
                    <label class="field-label" for="add-prefix">Route Prefix</label>
                    <input class="text-input" type="text" id="add-prefix" placeholder="/api/data">
                  </div>
                  <div>
                    <label class="field-label" for="add-target">Target URL</label>
                    <input class="text-input" type="text" id="add-target" placeholder="https://example.com/data">
                  </div>
                </div>
                <div class="form-actions">
                  <button class="btn btn-primary" onclick="addRoute()">Save Route</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  </div>
  <div class="toast" id="toast"></div>

  <script>
    let token = sessionStorage.getItem('admin_token') || '';
    const API = '${ADMIN_API_PREFIX}';

    if (token) tryAutoLogin();

    document.getElementById('password-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') doLogin();
    });

    async function doLogin() {
      token = document.getElementById('password-input').value;
      sessionStorage.setItem('admin_token', token);
      const ok = await apiCheck();
      if (ok) {
        showAdmin();
      } else {
        token = '';
        sessionStorage.removeItem('admin_token');
        toast('Password incorrect');
      }
    }

    async function tryAutoLogin() {
      if (await apiCheck()) showAdmin();
      else {
        token = '';
        sessionStorage.removeItem('admin_token');
      }
    }

    function showAdmin() {
      document.getElementById('login-section').style.display = 'none';
      document.getElementById('admin-section').style.display = 'block';
      loadRoutes();
    }

    function doLogout() {
      token = '';
      sessionStorage.removeItem('admin_token');
      document.getElementById('admin-section').style.display = 'none';
      document.getElementById('login-section').style.display = '';
      document.getElementById('password-input').value = '';
    }

    async function apiCheck() {
      try {
        const r = await fetch(API + '/check', { headers: { 'X-Admin-Token': token } });
        return r.ok;
      } catch { return false; }
    }

    async function loadRoutes() {
      try {
        const r = await fetch(API + '/routes', { headers: { 'X-Admin-Token': token } });
        const data = await r.json();

        if (!r.ok) {
          if (r.status === 401) doLogout();
          toast(data.error || 'Failed to load routes');
          return;
        }

        renderRoutes(data.routes || {});
      } catch (_) {
        toast('Failed to load routes');
      }
    }

    function renderRoutes(routes) {
      const entries = Object.entries(routes).sort(([a], [b]) => a.localeCompare(b));
      const routeCount = entries.length;
      document.getElementById('stat-routes').textContent = routeCount;
      document.getElementById('meta-route-count').textContent = routeCount;
      if (entries.length === 0) {
        document.getElementById('routes-list').innerHTML = '<div class="empty-msg">No routes configured yet.<br>Add your first prefix below to publish it to the edge.</div>';
        return;
      }
      const container = document.getElementById('routes-list');
      const list = document.createElement('div');
      list.className = 'routes-list';

      for (const [prefix, target] of entries) {
        const card = document.createElement('div');
        card.className = 'route-card';
        card.innerHTML = '<div class="route-icon">↗</div><div class="route-info"><div class="route-path">' + escHtml(prefix) + '</div><div class="route-target" title="' + escHtml(target) + '">' + escHtml(target) + '</div></div><div class="route-actions"></div>';
        const editBtn = document.createElement('button');
        editBtn.className = 'btn btn-edit btn-sm';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', () => editRoute(prefix, target));
        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-danger btn-sm';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', () => delRoute(prefix));
        const actions = card.querySelector('.route-actions');
        actions.appendChild(editBtn);
        actions.appendChild(delBtn);
        list.appendChild(card);
      }
      container.innerHTML = '';
      container.appendChild(list);
    }

    async function editRoute(prefix, target) {
      const newTarget = prompt('Edit target URL for ' + prefix, target);
      if (newTarget === null || newTarget.trim() === '' || newTarget.trim() === target) return;
      try {
        const r = await fetch(API + '/routes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
          body: JSON.stringify({ prefix, target: newTarget.trim() }),
        });
        const data = await r.json();
        if (data.ok) {
          renderRoutes(data.routes || {});
          toast('Route updated');
        } else {
          if (r.status === 401) doLogout();
          toast(data.error || 'Failed');
        }
      } catch (_) {
        toast('Failed');
      }
    }

    async function addRoute() {
      const prefix = document.getElementById('add-prefix').value.trim();
      const target = document.getElementById('add-target').value.trim();
      if (!prefix || !target) { toast('Please fill in both fields'); return; }
      const r = await fetch(API + '/routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
        body: JSON.stringify({ prefix, target }),
      });
      const data = await r.json();
      if (data.ok) {
        document.getElementById('add-prefix').value = '';
        document.getElementById('add-target').value = '';
        renderRoutes(data.routes || {});
        toast('Route added');
      } else {
        if (r.status === 401) doLogout();
        toast(data.error || 'Failed');
      }
    }

    async function delRoute(prefix) {
      if (!confirm('Delete ' + prefix + ' ?')) return;
      const r = await fetch(API + '/routes', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
        body: JSON.stringify({ prefix }),
      });
      const data = await r.json();
      if (data.ok) {
        renderRoutes(data.routes || {});
        toast('Route deleted');
      } else {
        if (r.status === 401) doLogout();
        toast(data.error || 'Failed');
      }
    }

    function escHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function toast(msg) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.classList.add('show');
      setTimeout(() => el.classList.remove('show'), 2000);
    }
  </script>
</body>
</html>`;
}
