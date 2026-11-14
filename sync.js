// Cloud-backup providers, same shape as Tachyread/GymTracker's sync layer:
//   • LOCAL FOLDER — File System Access dir handle; point it at a Drive/Dropbox/OneDrive
//     desktop sync folder and you get cloud backup with no accounts at all.
//   • GOOGLE DRIVE — private appDataFolder via Google Identity Services + Drive REST.
// The Drive bytes never touch any server of ours; it's your browser talking to your Drive.

export const BACKUP_NAME = 'microminiger-backup.json'; // distinct name: the OAuth client (and its
// app-data folder) is shared across the family of apps, so each app owns its own file.

// Public OAuth client id shared with Tachyread/GymTracker — an identifier, not a secret. Google
// only honours it from the registered JS origins; the gate below also refuses it app-side on any
// other origin, so a fork deployed elsewhere must supply its own client id.
export const BUILTIN_DRIVE_CLIENT_ID = '547617739897-br6dj2facmsc34qnkjb5u4dbfhju39pu.apps.googleusercontent.com';
const OAUTH_ORIGINS = ['https://adervec.github.io'];
export function driveOriginAllowed() {
  try {
    const h = location.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return true; // local dev, any port
    return OAUTH_ORIGINS.indexOf(location.origin) !== -1;
  } catch { return false; }
}
export function driveClientId(custom) {
  return (custom || '').trim() || (driveOriginAllowed() ? BUILTIN_DRIVE_CLIENT_ID : '');
}

/* ---------------- local folder ---------------- */
// Storage hooks are injected (the app owns the IndexedDB): {get(key), set(key, value)}.
let kv = {get: async () => null, set: async () => {}};
export function useKv(hooks) { kv = hooks; }

async function ensureDirPermission(handle, mode = 'readwrite') {
  if (!handle) return false;
  const opts = {mode};
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

export const folder = {
  supported: () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function',
  async connect() {
    let handle = await kv.get('syncDir');
    if (handle && (await ensureDirPermission(handle))) return handle;
    handle = await window.showDirectoryPicker({id: 'microminiger-sync', mode: 'readwrite'});
    if (!(await ensureDirPermission(handle))) throw new Error('Folder permission was denied.');
    await kv.set('syncDir', handle);
    return handle;
  },
  async name() { return (await kv.get('syncDir'))?.name || null; },
  async disconnect() { await kv.set('syncDir', null); },
  async upload(dir, name, blob) {
    const fh = await dir.getFileHandle(name, {create: true});
    const w = await fh.createWritable();
    await w.write(blob); await w.close();
  },
  async download(dir, name) {
    try { return await (await dir.getFileHandle(name)).getFile(); } catch { return null; }
  },
  async stat(dir, name) {
    try { return (await (await dir.getFileHandle(name)).getFile()).lastModified || null; } catch { return null; }
  },
};

/* ---------------- google drive (appDataFolder) ---------------- */
let gisLoaded = null;
function loadGis() {
  if (gisLoaded) return gisLoaded;
  gisLoaded = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load Google sign-in.'));
    document.head.appendChild(s);
  });
  return gisLoaded;
}
const DRIVE_SCOPE = 'openid email profile https://www.googleapis.com/auth/drive.appdata';

// Access token cached in memory only — never persisted.
let _token = null;    // { value, exp }
let _profile = null;  // { name, picture, email } — cosmetic
const tokenValid = () => !!_token && _token.exp > Date.now() + 60000;
export const getDriveProfile = () => _profile;

async function fetchProfile(token) {
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {headers: {Authorization: `Bearer ${token}`}});
    if (r.ok) {
      const j = await r.json();
      _profile = {name: j.name || j.email || 'Google account', picture: j.picture || '', email: j.email || ''};
      window.appFont?.setAccount(_profile); // house standard: the picture sits in the top bar while synced
    }
  } catch { /* cosmetic only */ }
}
function requestToken(clientId, prompt = '') {
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: resp => {
        if (resp?.access_token) {
          _token = {value: resp.access_token, exp: Date.now() + ((resp.expires_in || 3600) * 1000)};
          resolve(resp.access_token);
        } else reject(new Error(resp?.error || 'Sign-in failed.'));
      },
      error_callback: err => reject(new Error(err?.message || err?.type || 'Sign-in was dismissed.')),
    });
    client.requestAccessToken({prompt});
  });
}
async function find(token, name) {
  const q = encodeURIComponent(`name='${name}' and trashed=false`);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,name,modifiedTime)`,
    {headers: {Authorization: `Bearer ${token}`}});
  if (!r.ok) throw new Error(`Drive list failed (${r.status}).`);
  return (await r.json()).files?.[0] || null;
}

export const drive = {
  available: custom => !!driveClientId(custom),
  connected: () => tokenValid(),
  // silent (boot/auto) only reuses an existing grant — it never opens a popup.
  async connect(custom, {silent = false} = {}) {
    const clientId = driveClientId(custom);
    if (!clientId) throw new Error('Google Drive backup isn’t enabled on this deployment.');
    if (tokenValid()) { if (!_profile) await fetchProfile(_token.value); return {token: _token.value}; }
    await loadGis();
    let token;
    try { token = await requestToken(clientId, ''); }
    catch (e) { if (silent) throw e; token = await requestToken(clientId, 'consent'); }
    await fetchProfile(token);
    return {token};
  },
  disconnect() { _token = null; _profile = null; window.appFont?.setAccount(null); },
  async stat(conn, name) { return (await find(conn.token, name))?.modifiedTime || null; },
  async upload(conn, name, blob) {
    const existing = (await find(conn.token, name))?.id || null;
    const meta = existing ? {} : {name, parents: ['appDataFolder']};
    // multipart is capped at 5 MB; photo-laden backups blow past that → resumable protocol.
    if (blob.size > 4 * 1024 * 1024) {
      const initUrl = existing
        ? `https://www.googleapis.com/upload/drive/v3/files/${existing}?uploadType=resumable`
        : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';
      const init = await fetch(initUrl, {
        method: existing ? 'PATCH' : 'POST',
        headers: {Authorization: `Bearer ${conn.token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': blob.type || 'application/json'},
        body: JSON.stringify(meta),
      });
      if (!init.ok) throw new Error(`Drive upload init failed (${init.status}).`);
      const session = init.headers.get('Location');
      if (!session) throw new Error('Drive upload init returned no session URL.');
      const put = await fetch(session, {method: 'PUT', body: blob});
      if (!put.ok) throw new Error(`Drive upload failed (${put.status}).`);
      return;
    }
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(meta)], {type: 'application/json'}));
    form.append('file', blob);
    const url = existing
      ? `https://www.googleapis.com/upload/drive/v3/files/${existing}?uploadType=multipart`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    const r = await fetch(url, {method: existing ? 'PATCH' : 'POST', headers: {Authorization: `Bearer ${conn.token}`}, body: form});
    if (!r.ok) throw new Error(`Drive upload failed (${r.status}).`);
  },
  async download(conn, name) {
    const f = await find(conn.token, name);
    if (!f) return null;
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`, {headers: {Authorization: `Bearer ${conn.token}`}});
    if (!r.ok) throw new Error(`Drive download failed (${r.status}).`);
    return await r.blob();
  },
};
