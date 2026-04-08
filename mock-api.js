/* Client-side mock API for static hosting
   - intercepts fetch and XHR for paths starting with /mock-api and /admin-api/api
   - stores users in localStorage under key 'econ_sim_db'
*/
(function(){
  if (typeof window === 'undefined') return;
  const KEY = 'econ_sim_db_v1';
  function load(){
    try{ return JSON.parse(localStorage.getItem(KEY)) || null; }catch(e){return null}
  }
  function save(db){ localStorage.setItem(KEY, JSON.stringify(db)); }
  function init(){
    let db = load();
    if (!db) {
      db = { users: { 1: { id:1, username:'guest', displayName:'Guest', password:'guest', robux:1000, tix:0 } }, nextId:2, session: { userId: null } };
      save(db);
    }
    return db;
  }
  const db = init();

  function jsonResponse(obj, status=200){
    return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type':'application/json' } });
  }

  function parseBody(init){
    if (!init || !init.body) return null;
    try { return typeof init.body === 'string' ? JSON.parse(init.body) : init.body } catch(e){ return null }
  }

  async function handleRequest(url, init){
    // strip origin
    const u = new URL(url, location.origin);
    const path = u.pathname;
    const method = (init && init.method) ? init.method.toUpperCase() : 'GET';
    const query = Object.fromEntries(u.searchParams.entries());

    // auth login
    if (path === '/mock-api/auth/v2/login' && method === 'POST'){
      const body = init && init.body ? JSON.parse(init.body) : {};
      const { ctype, cvalue, password } = body;
      if (ctype === 'username'){
        const user = Object.values(db.users).find(u => u.username.toLowerCase() === (cvalue||'').toLowerCase());
        if (!user) return jsonResponse({ errors: [{ code:1, message: 'Invalid username' }]}, 400);
        if (user.password !== password) return jsonResponse({ errors: [{ code:2, message: 'Invalid password' }]}, 403);
        db.session.userId = user.id; save(db);
        return jsonResponse({ success:true, userId: user.id, username: user.username });
      }
    }

    if (path === '/mock-api/auth/v2/logout' && method === 'POST'){
      db.session.userId = null; save(db); return jsonResponse({ success:true });
    }

    if (path === '/mock-api/users/v1/users/authenticated' && method === 'GET'){
      const id = db.session.userId;
      if (!id) return jsonResponse({ errors: [{ code:401, message:'Not authenticated' }] }, 401);
      const uobj = db.users[id];
      if (!uobj) return jsonResponse({ errors: [{ code:404, message:'User not found' }] }, 404);
      return jsonResponse({ data: { id: uobj.id, username: uobj.username, displayName: uobj.displayName, robux: uobj.robux, tix: uobj.tix } });
    }

    // get user by id
    const usersIdMatch = path.match(/^\/mock-api\/users\/v1\/users\/(\d+)$/);
    if (usersIdMatch && method === 'GET'){
      const id = usersIdMatch[1];
      const uobj = db.users[id];
      if (!uobj) return jsonResponse({ errors: [{ code:404, message:'User not found' }] }, 404);
      return jsonResponse({ data: { id: uobj.id, username: uobj.username, displayName: uobj.displayName, robux: uobj.robux, tix: uobj.tix } });
    }

    if (path === '/mock-api/users/v1/usernames/users' && method === 'POST'){
      const body = init && init.body ? JSON.parse(init.body) : {};
      const usernames = body.usernames || [];
      const results = usernames.map(name => {
        const match = Object.values(db.users).find(u => u.username.toLowerCase() === (name||'').toLowerCase());
        if (match) return { id: match.id, username: match.username };
        return null;
      }).filter(Boolean);
      return jsonResponse({ data: results });
    }

    // search
    if (path === '/mock-api/search/users/results'){
      const q = (query.keyword||'').toLowerCase();
      const max = parseInt(query.maxRows || '20');
      const list = Object.values(db.users).filter(u => u.username.toLowerCase().includes(q)).slice(0, max).map(u => ({ UserId: u.id, Username: u.username, DisplayName: u.displayName }));
      return jsonResponse({ UserSearchResults: list, total: list.length });
    }

    // admin create via /admin-api/api/... e.g. /admin-api/api/users/create
    if (path.startsWith('/admin-api/api/') && method === 'POST'){
      if (path.includes('users') && path.includes('create')){
        const body = init && init.body ? JSON.parse(init.body) : {};
        const username = body.username || ('user'+db.nextId);
        const password = body.password || 'password';
        const displayName = body.displayName || username;
        const id = db.nextId++;
        db.users[id] = { id, username, password, displayName, robux:0, tix:0 };
        save(db);
        return jsonResponse({ success:true, id });
      }
    }

    // fallback: return empty JSON for other mock-api paths
    if (path.startsWith('/mock-api') || path.startsWith('/admin-api/api')){
      return jsonResponse({});
    }

    return null; // signal not handled
  }

  // patch fetch
  const _fetch = window.fetch.bind(window);
  window.fetch = async function(input, init){
    try{
      const url = typeof input === 'string' ? input : input.url;
      const handled = await handleRequest(url, init || {});
      if (handled) return handled;
    }catch(e){ console.error('mock-api fetch handler error', e); }
    return _fetch(input, init);
  }

  // patch XMLHttpRequest for axios
  const XHR = window.XMLHttpRequest;
  function MockXHR(){
    const xhr = new XHR();
    const origOpen = xhr.open;
    let method, url;
    xhr.open = function(m,u,async=true){ method = m; url = u; return origOpen.apply(xhr, arguments); };
    const origSend = xhr.send;
    xhr.send = function(body){
      const maybe = handleRequest(url, { method, body });
      if (maybe && typeof maybe.then === 'function'){
        maybe.then(resp => resp.text().then(text => {
          Object.defineProperty(xhr, 'status', { value: resp.status, configurable: true });
          Object.defineProperty(xhr, 'responseText', { value: text, configurable: true });
          try{ xhr.onreadystatechange && xhr.onreadystatechange(); }catch(e){}
          try{ xhr.onload && xhr.onload(); }catch(e){}
        })).catch(err => {
          try{ xhr.onerror && xhr.onerror(err); }catch(e){}
        });
        return;
      }
      return origSend.apply(xhr, arguments);
    };
    return xhr;
  }
  try{ window.XMLHttpRequest = MockXHR; }catch(e){/*ignore*/}

  // expose small helper for debugging
  window.__econMock = {
    dbKey: KEY,
    dump: () => JSON.parse(localStorage.getItem(KEY) || '{}'),
    reset: () => { localStorage.removeItem(KEY); init(); }
  };
})();
