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

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Warp</title>
  <link rel="icon" type="image/svg+xml" href="${favicon}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
      *, *::before, *::after { box-sizing: border-box; }
      body, html {
          height: 100%; margin: 0;
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          background: #f0f2f5; color: #1a1a2e;
      }
      .wrap {
          min-height: 100%; display: flex; align-items: center; justify-content: center;
          padding: 24px;
      }
      .card {
          width: 100%; max-width: 440px; padding: 40px;
          border-radius: 20px;
          background: rgba(255,255,255,0.7);
          backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
          border: 1px solid rgba(255,255,255,0.8);
          box-shadow: 0 8px 32px rgba(0,0,0,0.08);
      }
      .brand { display: flex; flex-direction: column; align-items: center; margin-bottom: 28px; }
      .brand svg { width: 72px; height: 72px; filter: drop-shadow(0 2px 8px rgba(20,184,166,0.3)); }
      .brand .name {
          margin-top: 12px; font-size: 0.85rem; font-weight: 600;
          letter-spacing: 0.3em; text-transform: uppercase; color: #14b8a6;
      }
      .empty-state {
          text-align: center; color: #64748b; font-size: 0.95rem;
          padding: 16px 8px;
      }
      ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
      li a {
          display: block; padding: 12px 16px; border-radius: 12px;
          background: rgba(0,0,0,0.03); text-decoration: none; color: inherit;
          transition: all 0.2s ease;
      }
      li a:hover { background: rgba(20,184,166,0.08); transform: translateX(4px); }
      li a code {
          background: none; padding: 0; font-size: 0.9em;
          font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .group { padding: 0; }
      .group > details { padding: 0; }
      .group summary {
          list-style: none; cursor: pointer; padding: 10px 16px;
          font-size: 0.9em; font-weight: 500; color: #64748b;
          user-select: none; border-radius: 10px; transition: background 0.15s;
      }
      .group summary:hover { background: rgba(0,0,0,0.03); }
      .group summary::-webkit-details-marker { display: none; }
      .group summary::before {
          content: ''; display: inline-block; width: 6px; height: 6px;
          border-right: 2px solid currentColor; border-bottom: 2px solid currentColor;
          transform: rotate(-45deg); margin-right: 10px;
          transition: transform 0.2s ease;
      }
      .group details[open] summary::before { transform: rotate(45deg); }
      .group details ul { padding-left: 12px; margin-top: 4px; margin-bottom: 4px; }
      @media (prefers-color-scheme: dark) {
          body, html { background: #0f0f14; color: #e2e8f0; }
          .card {
              background: rgba(30,30,40,0.8); border-color: rgba(255,255,255,0.06);
              box-shadow: 0 8px 32px rgba(0,0,0,0.4);
          }
          li a { background: rgba(255,255,255,0.04); }
          li a:hover { background: rgba(20,184,166,0.12); }
          .empty-state { color: #94a3b8; }
          .group summary { color: #94a3b8; }
          .group summary:hover { background: rgba(255,255,255,0.04); }
      }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="brand">
        ${LOGO_SVG}
        <div class="name">Warp</div>
      </div>
      ${routesHtml}
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
    *, *::before, *::after { box-sizing: border-box; }
    body, html {
      height: 100%; margin: 0;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f0f2f5; color: #1a1a2e;
    }
    .wrap {
      min-height: 100%; display: flex; align-items: center; justify-content: center;
      padding: 24px;
    }
    .card {
      width: 100%; max-width: 600px; padding: 40px;
      border-radius: 20px;
      background: rgba(255,255,255,0.7);
      backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.8);
      box-shadow: 0 8px 32px rgba(0,0,0,0.08);
    }
    .brand { display: flex; flex-direction: column; align-items: center; margin-bottom: 32px; }
    .brand svg { width: 48px; height: 48px; filter: drop-shadow(0 2px 8px rgba(20,184,166,0.3)); }
    .brand .name {
      margin-top: 10px; font-size: 0.8rem; font-weight: 600;
      letter-spacing: 0.3em; text-transform: uppercase; color: #14b8a6;
    }
    h2 { margin: 0; font-size: 1.05rem; font-weight: 600; color: #1a1a2e; }

    /* Login */
    #login-section { text-align: center; }
    #login-section input {
      width: 100%; padding: 12px 16px;
      border: 1.5px solid rgba(0,0,0,0.08); border-radius: 12px;
      font-size: 0.95rem; margin-bottom: 16px;
      background: rgba(255,255,255,0.6);
      transition: border-color 0.2s, box-shadow 0.2s;
      outline: none;
    }
    #login-section input:focus {
      border-color: #14b8a6;
      box-shadow: 0 0 0 3px rgba(20,184,166,0.12);
    }

    /* Buttons */
    .btn {
      padding: 10px 20px; border: none; border-radius: 10px;
      font-size: 0.875rem; font-weight: 500; cursor: pointer;
      transition: all 0.2s ease; outline: none;
    }
    .btn:active { transform: scale(0.97); }
    .btn-primary {
      background: linear-gradient(135deg, #14b8a6, #0d9488); color: #fff;
      box-shadow: 0 2px 8px rgba(20,184,166,0.3);
    }
    .btn-primary:hover { box-shadow: 0 4px 16px rgba(20,184,166,0.4); }
    .btn-danger { background: rgba(239,68,68,0.1); color: #ef4444; }
    .btn-danger:hover { background: rgba(239,68,68,0.18); }
    .btn-sm { padding: 6px 14px; font-size: 0.8rem; border-radius: 8px; }
    .btn-ghost { background: transparent; color: #64748b; }
    .btn-ghost:hover { background: rgba(0,0,0,0.04); color: #1a1a2e; }
    .btn-edit { background: rgba(20,184,166,0.1); color: #0d9488; }
    .btn-edit:hover { background: rgba(20,184,166,0.18); }

    /* Admin section */
    #admin-section { display: none; }
    .admin-header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 24px;
    }

    /* Route cards */
    .routes-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 24px; }
    .route-card {
      display: flex; align-items: center; gap: 12px;
      padding: 14px 16px; border-radius: 12px;
      background: rgba(0,0,0,0.025);
      transition: background 0.15s;
    }
    .route-card:hover { background: rgba(0,0,0,0.045); }
    .route-info { flex: 1; min-width: 0; }
    .route-path {
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.875rem; font-weight: 600; color: #14b8a6;
    }
    .route-target {
      font-size: 0.8rem; color: #64748b; margin-top: 3px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .route-actions { display: flex; gap: 6px; flex-shrink: 0; }
    .empty-msg {
      text-align: center; padding: 32px 0; color: #94a3b8; font-size: 0.9rem;
    }

    /* Add form */
    .add-form {
      display: flex; flex-direction: column; gap: 10px;
      padding-top: 20px; border-top: 1.5px solid rgba(0,0,0,0.05);
    }
    .add-form input {
      width: 100%; padding: 10px 14px;
      border: 1.5px solid rgba(0,0,0,0.08); border-radius: 10px;
      font-size: 0.9rem; background: rgba(255,255,255,0.6);
      outline: none; transition: border-color 0.2s, box-shadow 0.2s;
    }
    .add-form input:focus {
      border-color: #14b8a6;
      box-shadow: 0 0 0 3px rgba(20,184,166,0.12);
    }
    .add-form .row { display: flex; gap: 10px; }
    .add-form .row input { flex: 1; }

    /* Toast */
    .toast {
      position: fixed; bottom: 32px; left: 50%; transform: translateX(-50%) translateY(8px);
      padding: 12px 28px; border-radius: 12px; font-size: 0.875rem; font-weight: 500;
      background: #1a1a2e; color: #fff;
      box-shadow: 0 8px 24px rgba(0,0,0,0.15);
      opacity: 0; transition: all 0.3s ease;
      pointer-events: none; z-index: 99;
    }
    .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

    @media (prefers-color-scheme: dark) {
      body, html { background: #0f0f14; color: #e2e8f0; }
      .card {
        background: rgba(30,30,40,0.8); border-color: rgba(255,255,255,0.06);
        box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      }
      h2 { color: #e2e8f0; }
      #login-section input, .add-form input {
        background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.1);
        color: #e2e8f0;
      }
      .route-card { background: rgba(255,255,255,0.04); }
      .route-card:hover { background: rgba(255,255,255,0.07); }
      .route-target { color: #94a3b8; }
      .btn-ghost { color: #94a3b8; }
      .btn-ghost:hover { background: rgba(255,255,255,0.06); color: #e2e8f0; }
      .btn-danger { background: rgba(239,68,68,0.12); }
      .btn-danger:hover { background: rgba(239,68,68,0.2); }
      .btn-edit { background: rgba(20,184,166,0.12); }
      .btn-edit:hover { background: rgba(20,184,166,0.2); }
      .add-form { border-top-color: rgba(255,255,255,0.06); }
      .toast { background: #e2e8f0; color: #0f0f14; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="brand">
        ${LOGO_SVG}
        <div class="name">Warp</div>
      </div>

      <!-- Login -->
      <div id="login-section">
        <h2 style="text-align:center;margin-bottom:20px">Admin Login</h2>
        <input type="password" id="password-input" placeholder="Enter admin password" autofocus>
        <button class="btn btn-primary" onclick="doLogin()" style="width:100%">Login</button>
      </div>

      <!-- Admin Panel -->
      <div id="admin-section">
        <div class="admin-header">
          <h2>Route Management</h2>
          <button class="btn btn-ghost btn-sm" onclick="doLogout()">Logout</button>
        </div>
        <div id="routes-list"></div>
        <div class="add-form">
          <div class="row">
            <input type="text" id="add-prefix" placeholder="Path, e.g. /api/data">
            <input type="text" id="add-target" placeholder="Target URL">
          </div>
          <button class="btn btn-primary" onclick="addRoute()" style="align-self:flex-end">Add Route</button>
        </div>
      </div>
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
      if (entries.length === 0) {
        document.getElementById('routes-list').innerHTML = '<div class="empty-msg">No routes configured</div>';
        return;
      }
      const container = document.getElementById('routes-list');
      const list = document.createElement('div');
      list.className = 'routes-list';

      for (const [prefix, target] of entries) {
        const card = document.createElement('div');
        card.className = 'route-card';
        card.innerHTML = '<div class="route-info"><div class="route-path">' + escHtml(prefix) + '</div><div class="route-target" title="' + escHtml(target) + '">' + escHtml(target) + '</div></div><div class="route-actions"></div>';
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
