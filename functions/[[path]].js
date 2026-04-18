// Cloudflare Pages Functions 版本：catch-all 路由
// 核心逻辑与根目录的 worker.js 保持一致，入口改为 Pages Functions 的 onRequest。

export async function onRequest(context) {
  return handleRequest(context.request, context.env);
}

const ROUTES_KV_KEY = 'routes';
const ADMIN_API_PREFIX = '/admin/api';

// 从 KV 加载路由
async function loadRoutes(env) {
  if (env?.ROUTES_KV) {
    try {
      const routes = await env.ROUTES_KV.get(ROUTES_KV_KEY, 'json');
      return isPlainObject(routes) ? routes : {};
    } catch (_) {}
  }
  return {};
}

// 保存路由到 KV
async function saveRoutes(env, routes) {
  if (!env?.ROUTES_KV) {
    throw new Error('KV namespace ROUTES_KV not bound');
  }
  await env.ROUTES_KV.put(ROUTES_KV_KEY, JSON.stringify(routes));
}

// 验证管理员密码
function checkAuth(request, env) {
  const password = env?.ADMIN_PASSWORD || '';
  if (!password) return false;
  const token = request.headers.get('X-Admin-Token');
  return token === password;
}

async function handleRequest(request, env) {
  try {
    const url = new URL(request.url);

    // 管理后台路由
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      return new Response(getAdminHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    if (url.pathname === ADMIN_API_PREFIX || url.pathname.startsWith(ADMIN_API_PREFIX + '/')) {
      return handleAdminApi(request, url, env);
    }

    const routes = await loadRoutes(env);

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
async function handleAdminApi(request, url, env) {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (!checkAuth(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const path = url.pathname.replace(ADMIN_API_PREFIX, '') || '/';

  if (path === '/routes' && request.method === 'GET') {
    const routes = await loadRoutes(env);
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

    const routes = await loadRoutes(env);
    routes[prefix] = target;
    await saveRoutes(env, routes);
    return jsonResponse({ ok: true, routes }, 200);
  }

  if (path === '/routes' && request.method === 'DELETE') {
    const payload = await readJson(request);
    const prefix = normalizePrefix(payload?.prefix);
    if (!prefix || prefix === '/') {
      return jsonResponse({ error: 'valid prefix is required' }, 400);
    }
    const routes = await loadRoutes(env);
    delete routes[prefix];
    await saveRoutes(env, routes);
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
          --bg: #f4f7fb;
          --card: rgba(255, 255, 255, 0.88);
          --line: rgba(15, 23, 42, 0.08);
          --text: #0f172a;
          --muted: #64748b;
          --accent: #0f766e;
          --mono: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
      }
      *, *::before, *::after { box-sizing: border-box; }
      html, body { min-height: 100%; margin: 0; }
      body {
          font-family: 'Space Grotesk', 'Segoe UI', sans-serif;
          color: var(--text);
          background:
            radial-gradient(circle at top, rgba(15,118,110,0.08), transparent 36%),
            linear-gradient(180deg, #f8fafc 0%, #eef3f9 100%);
      }
      .wrap {
          min-height: 100vh;
          padding: 28px 16px;
          display: flex;
          align-items: center;
          justify-content: center;
      }
      .shell {
          width: min(760px, 100%);
          border: 1px solid var(--line);
          border-radius: 28px;
          background: var(--card);
          backdrop-filter: blur(18px);
          -webkit-backdrop-filter: blur(18px);
          box-shadow: 0 16px 40px rgba(15, 23, 42, 0.08);
          padding: 28px;
      }
      .brand {
          display: flex;
          align-items: center;
          gap: 14px;
      }
      .brand-mark {
          width: 56px;
          height: 56px;
          padding: 12px;
          display: grid;
          place-items: center;
          border-radius: 18px;
          background: rgba(15,118,110,0.08);
          border: 1px solid rgba(15,118,110,0.12);
      }
      .brand-mark svg { width: 100%; height: 100%; }
      .brand-meta strong {
          display: block;
          font-size: clamp(1.8rem, 4vw, 2.6rem);
          line-height: 1;
          letter-spacing: -0.04em;
      }
      .brand-meta span {
          display: block;
          margin-top: 6px;
          color: var(--muted);
          font-size: 0.82rem;
          letter-spacing: 0.12em;
          text-transform: uppercase;
      }
      .intro {
          margin: 22px 0 26px;
      }
      .intro h1 {
          margin: 0 0 10px;
          font-size: clamp(1.7rem, 4vw, 2.5rem);
          line-height: 1.05;
          letter-spacing: -0.05em;
      }
      .intro p {
          margin: 0;
          color: var(--muted);
          font-size: 0.98rem;
          line-height: 1.65;
      }
      .meta {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
          margin-bottom: 22px;
      }
      .meta-card {
          padding: 14px 16px;
          border-radius: 18px;
          background: rgba(255,255,255,0.72);
          border: 1px solid var(--line);
      }
      .meta-card strong {
          display: block;
          font-size: 1.2rem;
          letter-spacing: -0.04em;
      }
      .meta-card span {
          display: block;
          margin-top: 4px;
          color: var(--muted);
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 0.12em;
      }
      .panel-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 16px;
      }
      .panel-head h2 {
          margin: 0;
          font-size: 1.05rem;
          letter-spacing: -0.02em;
      }
      .panel-head p {
          margin: 4px 0 0;
          color: var(--muted);
          font-size: 0.9rem;
      }
      .pill {
          padding: 8px 10px;
          border-radius: 999px;
          border: 1px solid var(--line);
          background: rgba(255,255,255,0.72);
          color: var(--muted);
          font-size: 0.78rem;
      }
      .empty-state {
          padding: 24px 18px;
          border-radius: 20px;
          border: 1px dashed rgba(15, 23, 42, 0.12);
          background: rgba(255,255,255,0.52);
          text-align: center;
          color: var(--muted);
          line-height: 1.7;
      }
      ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px; }
      li a, .group summary {
          display: flex;
          align-items: center;
          width: 100%;
          min-height: 56px;
          padding: 13px 14px;
          border-radius: 18px;
          border: 1px solid var(--line);
          background: rgba(255,255,255,0.72);
          color: inherit;
          text-decoration: none;
          transition: border-color 0.16s ease, background 0.16s ease;
      }
      li a:hover, .group summary:hover {
          border-color: rgba(15,118,110,0.18);
          background: rgba(15,118,110,0.04);
      }
      li a::before {
          content: '↗';
          display: inline-grid;
          place-items: center;
          width: 34px;
          height: 34px;
          margin-right: 12px;
          border-radius: 12px;
          background: rgba(15,118,110,0.08);
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
          color: var(--text);
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
          border-left: 1px solid rgba(15,23,42,0.08);
      }
      @media (max-width: 640px) {
          .wrap { padding: 20px 14px; }
          .shell { padding: 20px; border-radius: 24px; }
          .meta { grid-template-columns: 1fr; }
      }
  </style>
</head>
<body>
  <div class="wrap">
    <main class="shell">
      <div class="brand">
        <div class="brand-mark">${LOGO_SVG}</div>
        <div class="brand-meta">
          <strong>Warp</strong>
          <span>Proxy Routes</span>
        </div>
      </div>
      <div class="intro">
        <h1>Cloudflare Workers Proxy</h1>
        <p>Browse the configured routes below and open the proxied destination directly.</p>
      </div>
      <div class="meta">
        <div class="meta-card">
          <strong>${routeCount}</strong>
          <span>Configured Routes</span>
        </div>
        <div class="meta-card">
          <strong>KV</strong>
          <span>Backed Config</span>
        </div>
        <div class="meta-card">
          <strong>/admin</strong>
          <span>Admin Panel</span>
        </div>
      </div>
      <section>
        <div class="panel-head">
          <div>
            <h2>Available Routes</h2>
            <p>Select a route to access its proxied target.</p>
          </div>
          <div class="pill">${routeCount} route${routeCount === 1 ? '' : 's'}</div>
        </div>
        ${routesHtml}
      </section>
    </main>
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
      --card: rgba(255, 255, 255, 0.88);
      --line: rgba(15, 23, 42, 0.08);
      --text: #0f172a;
      --muted: #64748b;
      --accent: #0f766e;
      --danger: #be123c;
      --mono: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
    }
    *, *::before, *::after { box-sizing: border-box; }
    html, body { min-height: 100%; margin: 0; }
    body {
      font-family: 'Space Grotesk', 'Segoe UI', sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top, rgba(15,118,110,0.08), transparent 36%),
        linear-gradient(180deg, #f8fafc 0%, #eef3f9 100%);
    }
    .wrap {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 28px;
    }
    .layout {
      width: min(820px, 100%);
    }
    .card {
      border-radius: 28px;
      border: 1px solid var(--line);
      background: var(--card);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      box-shadow: 0 16px 40px rgba(15, 23, 42, 0.08);
      padding: 24px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 22px;
    }
    .brand-mark {
      width: 56px;
      height: 56px;
      display: grid;
      place-items: center;
      padding: 12px;
      border-radius: 18px;
      background: rgba(15,118,110,0.08);
      border: 1px solid rgba(15,118,110,0.12);
    }
    .brand-mark svg { width: 100%; height: 100%; }
    .brand-copy strong {
      display: block;
      font-size: 1.45rem;
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
    .section-copy {
      margin: 0;
      color: var(--muted);
      line-height: 1.7;
      font-size: 0.94rem;
    }
    .surface {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .metric {
      padding: 14px 16px;
      border-radius: 18px;
      background: rgba(255,255,255,0.72);
      border: 1px solid var(--line);
    }
    .metric strong {
      display: block;
      font-size: 1.15rem;
      letter-spacing: -0.04em;
    }
    .metric span {
      display: block;
      margin-top: 4px;
      color: var(--muted);
      font-size: 0.78rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .panel {
      border-radius: 22px;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.68);
      padding: 20px;
    }
    .login-shell {
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
      font-size: 1.08rem;
      letter-spacing: -0.04em;
      color: var(--text);
    }
    .mini-pill {
      padding: 8px 11px;
      border-radius: 999px;
      background: rgba(15,118,110,0.06);
      border: 1px solid rgba(15,118,110,0.12);
      color: var(--accent);
      font-size: 0.78rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .field-label {
      display: block;
      margin-bottom: 8px;
      color: var(--muted);
      font-size: 0.84rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .text-input {
      width: 100%;
      min-height: 52px;
      padding: 14px 16px;
      border-radius: 16px;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.82);
      color: var(--text);
      outline: none;
      font: inherit;
      transition: border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
    }
    .text-input::placeholder { color: #94a3b8; }
    .text-input:focus {
      border-color: rgba(15,118,110,0.2);
      box-shadow: 0 0 0 4px rgba(15,118,110,0.08);
      background: #fff;
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
      transition: background 0.16s ease, border-color 0.16s ease;
    }
    .btn-primary {
      color: #fff;
      background: #0f766e;
    }
    .btn-ghost {
      color: var(--muted);
      background: rgba(255,255,255,0.8);
      border: 1px solid var(--line);
    }
    .btn-edit {
      color: var(--accent);
      background: rgba(15,118,110,0.06);
      border: 1px solid rgba(15,118,110,0.12);
    }
    .btn-danger {
      color: var(--danger);
      background: rgba(190,18,60,0.06);
      border: 1px solid rgba(190,18,60,0.12);
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
      gap: 14px;
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
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.82);
    }
    .route-icon {
      width: 44px;
      height: 44px;
      display: grid;
      place-items: center;
      border-radius: 14px;
      background: rgba(15,118,110,0.08);
      color: var(--accent);
      font-size: 1rem;
      flex: 0 0 auto;
    }
    .route-info { flex: 1; min-width: 0; }
    .route-path {
      font-family: var(--mono);
      font-size: 0.94rem;
      font-weight: 700;
      color: var(--text);
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
      border: 1px dashed rgba(15,23,42,0.12);
      background: rgba(255,255,255,0.58);
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
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.96);
      color: var(--text);
      box-shadow: 0 10px 28px rgba(15,23,42,0.08);
      opacity: 0;
      transition: opacity 0.25s ease, transform 0.25s ease;
      pointer-events: none;
      z-index: 99;
    }
    .toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    @media (max-width: 720px) {
      .wrap { padding: 16px; }
      .card { padding: 18px; border-radius: 24px; }
      .admin-header { flex-direction: column; }
      .admin-meta, .form-grid { grid-template-columns: 1fr; }
      .route-card { flex-direction: column; align-items: flex-start; }
      .route-actions { width: 100%; justify-content: flex-end; }
      .login-shell .title { flex-direction: column; align-items: flex-start; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="layout">
      <main class="card">
        <div class="brand">
          <div class="brand-mark">${LOGO_SVG}</div>
          <div class="brand-copy">
            <strong>Warp</strong>
            <span>Admin Panel</span>
          </div>
        </div>
        <div class="surface">
          <div id="login-section" class="login-shell">
            <div class="title">
              <div>
                <h2>Admin Login</h2>
                <p class="section-copy">Enter the admin password to manage routes.</p>
              </div>
              <div class="mini-pill">Protected</div>
            </div>
            <div class="panel">
              <label class="field-label" for="password-input">Admin Password</label>
              <input class="text-input" type="password" id="password-input" placeholder="Enter admin password" autofocus>
              <div style="margin-top:14px">
                <button class="btn btn-primary" onclick="doLogin()" style="width:100%">Login</button>
              </div>
            </div>
          </div>

          <div id="admin-section">
            <div class="admin-header">
              <div>
                <h2>Route Management</h2>
                <p class="section-copy">View, edit, and remove the currently configured routes.</p>
              </div>
              <button class="btn btn-ghost btn-sm" onclick="doLogout()">Logout</button>
            </div>
            <div class="admin-meta">
              <div class="metric">
                <strong id="meta-route-count">0</strong>
                <span>Total Routes</span>
              </div>
              <div class="metric">
                <strong id="stat-routes">0</strong>
                <span>Loaded Routes</span>
              </div>
              <div class="metric">
                <strong>KV</strong>
                <span>Persistent Store</span>
              </div>
            </div>
            <div class="panel">
              <div id="routes-list"></div>
            </div>
            <div class="panel">
              <div style="margin-bottom:16px">
                <h2 style="font-size:1.05rem">Add Route</h2>
                <p class="section-copy">Enter a path prefix and the target URL for the proxy route.</p>
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
                  <button class="btn btn-primary" onclick="addRoute()">Add Route</button>
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
