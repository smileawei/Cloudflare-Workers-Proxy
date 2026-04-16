addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

// 从 KV 加载路由
async function loadRoutes() {
  if (typeof ROUTES_KV !== 'undefined') {
    try {
      return (await ROUTES_KV.get('routes', 'json')) || {};
    } catch (_) {}
  }
  return {};
}

// 保存路由到 KV
async function saveRoutes(routes) {
  if (typeof ROUTES_KV === 'undefined') {
    throw new Error('KV namespace ROUTES_KV not bound');
  }
  await ROUTES_KV.put('routes', JSON.stringify(routes));
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
    if (url.pathname.startsWith('/admin/api/')) {
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
    const actualUrlStr = target + remaining + url.search;

    const newHeaders = filterHeaders(request.headers, name => !name.startsWith('cf-'));

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

  const path = url.pathname.replace('/admin/api', '');

  if (path === '/routes' && request.method === 'GET') {
    const routes = await loadRoutes();
    return jsonResponse({ routes }, 200);
  }

  if (path === '/routes' && request.method === 'POST') {
    const { prefix, target } = await request.json();
    if (!prefix || !target) {
      return jsonResponse({ error: 'prefix and target are required' }, 400);
    }
    if (!prefix.startsWith('/')) {
      return jsonResponse({ error: 'prefix must start with /' }, 400);
    }
    const routes = await loadRoutes();
    routes[prefix] = target;
    await saveRoutes(routes);
    return jsonResponse({ ok: true, routes }, 200);
  }

  if (path === '/routes' && request.method === 'DELETE') {
    const { prefix } = await request.json();
    if (!prefix) {
      return jsonResponse({ error: 'prefix is required' }, 400);
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
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
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

function handleRedirect(response, prefix, target) {
  const location = response.headers.get('location');
  if (!location) return response;

  let modifiedLocation = location;
  try {
    const locUrl = new URL(location, target);
    if (locUrl.origin === new URL(target).origin) {
      modifiedLocation = prefix + locUrl.pathname + locUrl.search + locUrl.hash;
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
  const regex = /((?:href|src|action)=["'])\/(?!\/)/g;
  return originalText.replace(regex, `$1${prefix}/`);
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
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  headers.set('Access-Control-Allow-Headers', '*');
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
    .map(([name, items]) => {
      const inner = items.map(liFor).join('');
      return `<li class="group"><details><summary>${escapeHtml(name)}/</summary><ul>${inner}</ul></details></li>`;
    })
    .join('');

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
      body, html {
          height: 100%;
          margin: 0;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          background: #ffffff;
          color: #2c3e50;
      }
      .wrap {
          min-height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          box-sizing: border-box;
      }
      .card {
          width: 100%;
          max-width: 420px;
          padding: 32px 36px;
          border-radius: 12px;
          background: #f7f7f8;
          box-shadow: 0 4px 20px rgba(0,0,0,0.06);
      }
      .brand {
          display: flex;
          flex-direction: column;
          align-items: center;
          margin-bottom: 24px;
      }
      .brand svg {
          width: 88px;
          height: 88px;
      }
      .brand .name {
          margin-top: 10px;
          font-size: 1.1rem;
          font-weight: 300;
          letter-spacing: 0.25em;
          text-transform: uppercase;
      }
      ul { list-style: none; padding: 0; margin: 0; }
      li {
          padding: 10px 0;
          border-bottom: 1px solid rgba(0,0,0,0.08);
      }
      li:last-child { border-bottom: none; }
      a { color: inherit; text-decoration: none; }
      a:hover code { background: rgba(0,0,0,0.1); }
      code {
          background: rgba(0,0,0,0.05);
          padding: 3px 8px;
          border-radius: 4px;
          font-size: 0.95em;
      }
      .group { padding: 0; }
      .group > details { padding: 0; }
      .group summary {
          list-style: none;
          cursor: pointer;
          padding: 10px 0;
          font-size: 0.95em;
          opacity: 0.75;
          user-select: none;
      }
      .group summary::-webkit-details-marker { display: none; }
      .group summary::before {
          content: '▸';
          display: inline-block;
          margin-right: 8px;
          font-size: 0.8em;
          transition: transform 0.15s ease;
      }
      .group details[open] summary::before {
          transform: rotate(90deg);
      }
      .group details ul {
          padding-left: 20px;
          margin-bottom: 4px;
      }
      .group details li {
          padding: 8px 0;
          border-bottom: 1px dashed rgba(0,0,0,0.08);
      }
      .group details li:last-child { border-bottom: none; }
      @media (prefers-color-scheme: dark) {
          body, html { background: #121212; color: #e0e0e0; }
          .card { background: #1e1e1e; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
          li { border-bottom-color: rgba(255,255,255,0.1); }
          code { background: rgba(255,255,255,0.08); }
          a:hover code { background: rgba(255,255,255,0.15); }
          .group details li { border-bottom-color: rgba(255,255,255,0.08); }
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
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #ffffff; color: #2c3e50;
    }
    .wrap {
      min-height: 100%; display: flex; align-items: center; justify-content: center;
      padding: 24px;
    }
    .card {
      width: 100%; max-width: 560px; padding: 32px 36px;
      border-radius: 12px; background: #f7f7f8;
      box-shadow: 0 4px 20px rgba(0,0,0,0.06);
    }
    .brand { display: flex; flex-direction: column; align-items: center; margin-bottom: 24px; }
    .brand svg { width: 56px; height: 56px; }
    .brand .name { margin-top: 8px; font-size: 0.9rem; font-weight: 300; letter-spacing: 0.25em; text-transform: uppercase; }
    h2 { margin: 0 0 20px; font-size: 1.1rem; font-weight: 500; text-align: center; }

    /* Login */
    #login-section { text-align: center; }
    #login-section input {
      width: 100%; padding: 10px 14px; border: 1px solid rgba(0,0,0,0.15);
      border-radius: 8px; font-size: 0.95rem; margin-bottom: 12px;
      background: #fff;
    }
    /* Buttons */
    .btn {
      padding: 8px 18px; border: none; border-radius: 8px;
      font-size: 0.9rem; cursor: pointer; transition: background 0.15s;
    }
    .btn-primary { background: #14b8a6; color: #fff; }
    .btn-primary:hover { background: #0d9488; }
    .btn-danger { background: #ef4444; color: #fff; }
    .btn-danger:hover { background: #dc2626; }
    .btn-sm { padding: 5px 12px; font-size: 0.8rem; }
    .btn-outline { background: transparent; border: 1px solid rgba(0,0,0,0.15); color: inherit; }
    .btn-outline:hover { background: rgba(0,0,0,0.05); }

    /* Routes table */
    #admin-section { display: none; }
    .route-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
    .route-table th, .route-table td {
      text-align: left; padding: 8px 6px; font-size: 0.85rem;
      border-bottom: 1px solid rgba(0,0,0,0.08);
    }
    .route-table th { opacity: 0.6; font-weight: 500; }
    .route-table td.target { word-break: break-all; max-width: 260px; }
    .route-table td code {
      background: rgba(0,0,0,0.05); padding: 2px 6px; border-radius: 4px; font-size: 0.85em;
    }
    .empty-msg { text-align: center; padding: 20px 0; opacity: 0.5; font-size: 0.9rem; }

    /* Add form */
    .add-form { display: flex; flex-direction: column; gap: 10px; padding-top: 16px; border-top: 1px solid rgba(0,0,0,0.08); }
    .add-form input {
      width: 100%; padding: 8px 12px; border: 1px solid rgba(0,0,0,0.15);
      border-radius: 8px; font-size: 0.9rem; background: #fff;
    }
    .add-form .row { display: flex; gap: 10px; }
    .add-form .row input { flex: 1; }

    .toast {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      padding: 10px 24px; border-radius: 8px; font-size: 0.9rem;
      background: #1e1e1e; color: #fff; opacity: 0; transition: opacity 0.3s;
      pointer-events: none; z-index: 99;
    }
    .toast.show { opacity: 1; }

    @media (prefers-color-scheme: dark) {
      body, html { background: #121212; color: #e0e0e0; }
      .card { background: #1e1e1e; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
      #login-section input, .add-form input { background: #2a2a2a; border-color: rgba(255,255,255,0.15); color: #e0e0e0; }
      .route-table th, .route-table td { border-bottom-color: rgba(255,255,255,0.1); }
      .route-table td code { background: rgba(255,255,255,0.08); }
      .add-form { border-top-color: rgba(255,255,255,0.1); }
      .toast { background: #f7f7f8; color: #2c3e50; }
      .btn-outline { border-color: rgba(255,255,255,0.15); }
      .btn-outline:hover { background: rgba(255,255,255,0.08); }
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
        <h2>Admin Login</h2>
        <input type="password" id="password-input" placeholder="Enter admin password" autofocus>
        <br>
        <button class="btn btn-primary" onclick="doLogin()" style="width:100%">Login</button>
      </div>

      <!-- Admin Panel -->
      <div id="admin-section">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
          <h2 style="margin:0">Route Management</h2>
          <button class="btn btn-outline btn-sm" onclick="doLogout()">Logout</button>
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
    const API = '/admin/api';

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
        sessionStorage.removeItem('admin_token');
        toast('Password incorrect');
      }
    }

    async function tryAutoLogin() {
      if (await apiCheck()) showAdmin();
      else sessionStorage.removeItem('admin_token');
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
      const r = await fetch(API + '/routes', { headers: { 'X-Admin-Token': token } });
      const data = await r.json();
      renderRoutes(data.routes || {});
    }

    function renderRoutes(routes) {
      const entries = Object.entries(routes);
      if (entries.length === 0) {
        document.getElementById('routes-list').innerHTML = '<div class="empty-msg">No routes configured</div>';
        return;
      }
      const container = document.getElementById('routes-list');
      const table = document.createElement('table');
      table.className = 'route-table';
      table.innerHTML = '<thead><tr><th>Path</th><th>Target</th><th></th></tr></thead>';
      const tbody = document.createElement('tbody');

      for (const [prefix, target] of entries) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td><code>' + escHtml(prefix) + '</code></td><td class="target">' + escHtml(target) + '</td><td style="white-space:nowrap"></td>';
        const editBtn = document.createElement('button');
        editBtn.className = 'btn btn-outline btn-sm';
        editBtn.textContent = 'Edit';
        editBtn.style.marginRight = '6px';
        editBtn.addEventListener('click', () => editRoute(prefix, target));
        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-danger btn-sm';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', () => delRoute(prefix));
        tr.lastChild.appendChild(editBtn);
        tr.lastChild.appendChild(delBtn);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      container.innerHTML = '';
      container.appendChild(table);
    }

    function editRoute(prefix, target) {
      const newTarget = prompt('Edit target URL for ' + prefix, target);
      if (newTarget === null || newTarget.trim() === '' || newTarget.trim() === target) return;
      fetch(API + '/routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
        body: JSON.stringify({ prefix, target: newTarget.trim() }),
      }).then(r => r.json()).then(data => {
        if (data.ok) { renderRoutes(data.routes || {}); toast('Route updated'); }
        else toast(data.error || 'Failed');
      });
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
