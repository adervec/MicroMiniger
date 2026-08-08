// recon3d.js — 3D for MicroMiniger: photo→mesh reconstruction (silhouette space
// carving + surface nets), mesh I/O, Gaussian-splat parsing/rendering, and
// NeRF/splat capture export. No dependencies; pure functions are node-testable.

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const D2R = Math.PI / 180;

/* ============================ silhouette ============================ */

function flood(mask, w, h, want) {
  // BFS from every border pixel over cells equal to `want`; returns reached map
  const n = w * h, seen = new Uint8Array(n), stack = new Int32Array(n);
  let sp = 0;
  const seed = i => { if (mask[i] === want && !seen[i]) { seen[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (sp) {
    const i = stack[--sp], x = i % w, y = (i / w) | 0;
    if (x > 0 && mask[i - 1] === want && !seen[i - 1]) { seen[i - 1] = 1; stack[sp++] = i - 1; }
    if (x < w - 1 && mask[i + 1] === want && !seen[i + 1]) { seen[i + 1] = 1; stack[sp++] = i + 1; }
    if (y > 0 && mask[i - w] === want && !seen[i - w]) { seen[i - w] = 1; stack[sp++] = i - w; }
    if (y < h - 1 && mask[i + w] === want && !seen[i + w]) { seen[i + w] = 1; stack[sp++] = i + w; }
  }
  return seen;
}

function largestComponent(mask, w, h) {
  const n = w * h, lab = new Int32Array(n).fill(-1), stack = new Int32Array(n);
  let best = -1, bestSize = 0, id = 0;
  for (let s = 0; s < n; s++) {
    if (!mask[s] || lab[s] >= 0) continue;
    let sp = 0, size = 0; stack[sp++] = s; lab[s] = id;
    while (sp) {
      const i = stack[--sp]; size++;
      const x = i % w, y = (i / w) | 0;
      const push = j => { if (mask[j] && lab[j] < 0) { lab[j] = id; stack[sp++] = j; } };
      if (x > 0) push(i - 1); if (x < w - 1) push(i + 1);
      if (y > 0) push(i - w); if (y < h - 1) push(i + w);
    }
    if (size > bestSize) { bestSize = size; best = id; }
    id++;
  }
  if (best < 0) return 0;
  for (let i = 0; i < n; i++) if (mask[i] && lab[i] !== best) mask[i] = 0;
  return bestSize;
}

// Background-subtraction silhouette: border pixels model the backdrop, holes are
// filled, and only the largest blob survives.
export function silhouette(px, w, h, {thresh = 0.16, border = 2} = {}) {
  const samples = [];
  for (let x = 0; x < w; x++) for (let b = 0; b < border; b++) { samples.push((b * w + x) * 4, ((h - 1 - b) * w + x) * 4); }
  for (let y = 0; y < h; y++) for (let b = 0; b < border; b++) { samples.push((y * w + b) * 4, (y * w + w - 1 - b) * 4); }
  const med = ch => { const a = samples.map(i => px[i + ch]).sort((p, q) => p - q); return a[a.length >> 1]; };
  const br = med(0), bg = med(1), bb = med(2);
  const t2 = (thresh * 441.673) ** 2;               // squared: no sqrt per pixel
  const n = w * h, mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const dr = px[i * 4] - br, dg = px[i * 4 + 1] - bg, db = px[i * 4 + 2] - bb;
    mask[i] = dr * dr + dg * dg + db * db > t2 ? 1 : 0;
  }
  const outside = flood(mask, w, h, 0);             // background reachable from frame edge
  for (let i = 0; i < n; i++) if (!mask[i] && !outside[i]) mask[i] = 1;   // fill enclosed holes
  largestComponent(mask, w, h);
  return mask;
}

/* ============================ turntable geometry ============================ */

export function viewAngles(n, arc = 360, reverse = false) {
  const step = (arc === 360 || n < 2) ? arc / n : arc / (n - 1);
  return Array.from({length: n}, (_, k) => (reverse ? -1 : 1) * k * step * D2R);
}

// Common frame for all views: rotation axis x, vertical centre/scale, half-width.
export function normalizeViews(masks, w, h) {
  let top = h, bot = -1, cxSum = 0, used = 0;
  const boxes = masks.map(m => {
    let x0 = w, x1 = -1, y0 = h, y1 = -1, sx = 0, cnt = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      sx += x; cnt++;
    }
    return {x0, x1, y0, y1, cx: cnt ? sx / cnt : w / 2, cnt};
  });
  for (const b of boxes) {
    if (!b.cnt) continue;
    if (b.y0 < top) top = b.y0;
    if (b.y1 > bot) bot = b.y1;
    cxSum += b.cx; used++;
  }
  if (!used) throw new Error('No subject found in any photo — try a plainer background or a lower threshold.');
  const s = Math.max((bot - top + 1) / 2, 1);
  const axisX = cxSum / used;
  let hx = 0.05;
  for (const b of boxes) if (b.cnt) hx = Math.max(hx, (b.x1 - axisX) / s, (axisX - b.x0) / s);
  return {axisX, vBase: (top + bot) / 2, s, hx, boxes};
}

// World point -> pixel, for view angle th and elevation elev (radians).
export function project(norm, th, elev, x, y, z) {
  const st = Math.sin(th), ct = Math.cos(th), sf = Math.sin(elev), cf = Math.cos(elev);
  const u = x * st - z * ct;
  const v = y * cf - sf * (x * ct + z * st);
  return {px: norm.axisX + u * norm.s, py: norm.vBase - v * norm.s};
}
export const cameraDir = (th, elev) => [Math.cos(elev) * Math.cos(th), Math.sin(elev), Math.cos(elev) * Math.sin(th)];

/* ============================ space carving ============================ */

// Visual hull: a voxel survives only if it lands inside the silhouette of all but
// `tol` views. Returns {occ, dims, extents} in object space (height spans ±1).
export async function carve(masks, w, h, norm, opts = {}, onProgress) {
  const {res = 128, arc = 360, elev = 0, tol = 0, reverse = false} = opts;
  const nx = res, ny = res, nz = res;
  const ex = norm.hx * 1.05, ey = 1.05, ez = norm.hx * 1.05;
  const miss = new Uint8Array(nx * ny * nz);
  const angles = viewAngles(masks.length, arc, reverse);
  const sf = Math.sin(elev * D2R), cf = Math.cos(elev * D2R);
  const dxw = 2 * ex / (nx - 1);
  for (let k = 0; k < masks.length; k++) {
    const mask = masks[k], st = Math.sin(angles[k]), ct = Math.cos(angles[k]);
    const dux = dxw * st, dvx = -sf * ct * dxw;
    for (let iz = 0; iz < nz; iz++) {
      const z = -ez + 2 * ez * iz / (nz - 1);
      for (let iy = 0; iy < ny; iy++) {
        const y = -ey + 2 * ey * iy / (ny - 1);
        let u = -ex * st - z * ct;
        let v = y * cf - sf * (-ex * ct + z * st);
        let o = nx * (iy + ny * iz);
        for (let ix = 0; ix < nx; ix++, u += dux, v += dvx, o++) {
          if (miss[o] > tol) continue;
          const px = (norm.axisX + u * norm.s + 0.5) | 0, py = (norm.vBase - v * norm.s + 0.5) | 0;
          if (px < 0 || px >= w || py < 0 || py >= h || !mask[py * w + px]) miss[o]++;
        }
      }
    }
    if (onProgress) await onProgress((k + 1) / masks.length);
  }
  const occ = new Uint8Array(nx * ny * nz);
  for (let i = 0; i < occ.length; i++) occ[i] = miss[i] > tol ? 0 : 1;
  // open the boundary shell so the surface always closes
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++)
    if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) occ[x + nx * y + nx * ny * z] = 0;
  return {occ, dims: [nx, ny, nz], extents: [ex, ey, ez], angles};
}

// Separable 3-tap blur: turns the binary hull into a smooth field so surface nets
// can place vertices sub-voxel instead of on cell midpoints.
export function blur3(occ, dims, passes = 1) {
  const [nx, ny, nz] = dims, n = nx * ny * nz, strides = [1, nx, nx * ny];
  let a = Float32Array.from(occ), b = new Float32Array(n);
  for (let p = 0; p < passes; p++) {
    for (let axis = 0; axis < 3; axis++) {
      const step = strides[axis], len = dims[axis], block = step * len;
      for (let base0 = 0; base0 < n; base0 += block)     // x-fastest layout: walk each line
        for (let off = 0; off < step; off++) {
          const base = base0 + off;
          for (let k = 0, i = base; k < len; k++, i += step) {
            const lo = k > 0 ? a[i - step] : a[i];
            const hi = k < len - 1 ? a[i + step] : a[i];
            b[i] = (lo + 2 * a[i] + hi) * 0.25;
          }
        }
      const t = a; a = b; b = t;
    }
  }
  return a;
}

/* ============================ surface nets ============================ */

const CUBE_EDGES = new Int32Array(24), EDGE_TABLE = new Int32Array(256);
{
  let k = 0;
  for (let i = 0; i < 8; i++) for (let j = 1; j <= 4; j <<= 1) { const p = i ^ j; if (i <= p) { CUBE_EDGES[k++] = i; CUBE_EDGES[k++] = p; } }
  for (let i = 0; i < 256; i++) {
    let em = 0;
    for (let j = 0; j < 24; j += 2)
      if (!!(i & (1 << CUBE_EDGES[j])) !== !!(i & (1 << CUBE_EDGES[j + 1]))) em |= 1 << (j >> 1);
    EDGE_TABLE[i] = em;
  }
}

// Naive surface nets — one vertex per straddling cell, quads across sign-changing
// edges. ponytail: no 256-entry marching-cubes table needed; smoother on binary data.
export function surfaceNets(field, dims, iso = 0.5) {
  const [nx, ny, nz] = dims;
  const R = [1, nx, nx * ny];
  const pos = [], idx = [];
  const vid = new Int32Array(nx * ny * nz).fill(-1);
  const g = new Float32Array(8);
  for (let z = 0; z < nz - 1; z++) for (let y = 0; y < ny - 1; y++) for (let x = 0; x < nx - 1; x++) {
    const base = x + nx * y + nx * ny * z;
    let mask = 0, c = 0;
    for (let k = 0; k < 2; k++) for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const v = field[base + i + nx * j + nx * ny * k];
      g[c] = v; if (v > iso) mask |= 1 << c;
      c++;
    }
    if (mask === 0 || mask === 255) continue;
    const em = EDGE_TABLE[mask];
    let vx = 0, vy = 0, vz = 0, cnt = 0;
    for (let e = 0; e < 12; e++) {
      if (!(em & (1 << e))) continue;
      const a = CUBE_EDGES[e * 2], b = CUBE_EDGES[e * 2 + 1];
      let t = (iso - g[a]) / (g[b] - g[a]);
      if (!isFinite(t)) t = 0.5;
      t = clamp(t, 0, 1);
      const ax = a & 1, ay = (a >> 1) & 1, az = (a >> 2) & 1;
      vx += ax + ((b & 1) - ax) * t;
      vy += ay + (((b >> 1) & 1) - ay) * t;
      vz += az + (((b >> 2) & 1) - az) * t;
      cnt++;
    }
    vid[base] = pos.length / 3;
    pos.push(x + vx / cnt, y + vy / cnt, z + vz / cnt);
    for (let i = 0; i < 3; i++) {
      if (!(em & (1 << i))) continue;
      const iu = (i + 1) % 3, iv = (i + 2) % 3;
      if ([x, y, z][iu] === 0 || [x, y, z][iv] === 0) continue;
      const du = R[iu], dv = R[iv];
      const v0 = vid[base], v1 = vid[base - du], v2 = vid[base - du - dv], v3 = vid[base - dv];
      if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) continue;
      if (mask & 1) idx.push(v0, v1, v2, v0, v2, v3);
      else idx.push(v0, v2, v1, v0, v3, v2);
    }
  }
  return {pos: new Float32Array(pos), idx: new Uint32Array(idx)};
}

// ponytail: flat CSR adjacency, no Sets — duplicate neighbours just weight by
// shared-triangle count, which is the usual umbrella weighting anyway.
export function smoothMesh(mesh, iters = 2, weight = 0.5) {
  const {pos, idx} = mesh, n = pos.length / 3;
  const start = new Uint32Array(n + 1);
  for (let i = 0; i < idx.length; i++) start[idx[i] + 1] += 2;
  for (let i = 0; i < n; i++) start[i + 1] += start[i];
  const adj = new Uint32Array(idx.length * 2), cur = Uint32Array.from(start.subarray(0, n));
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    adj[cur[a]++] = b; adj[cur[a]++] = c;
    adj[cur[b]++] = a; adj[cur[b]++] = c;
    adj[cur[c]++] = a; adj[cur[c]++] = b;
  }
  let p = pos;
  for (let it = 0; it < iters; it++) {
    const q = new Float32Array(p);
    for (let v = 0; v < n; v++) {
      const s0 = start[v], s1 = start[v + 1], k = s1 - s0;
      if (!k) continue;
      let sx = 0, sy = 0, sz = 0;
      for (let e = s0; e < s1; e++) { const u = adj[e] * 3; sx += p[u]; sy += p[u + 1]; sz += p[u + 2]; }
      q[v * 3] += weight * (sx / k - p[v * 3]);
      q[v * 3 + 1] += weight * (sy / k - p[v * 3 + 1]);
      q[v * 3 + 2] += weight * (sz / k - p[v * 3 + 2]);
    }
    p = q;
  }
  mesh.pos = p;
  return mesh;
}

export function computeNormals(mesh) {
  const {pos, idx} = mesh, nrm = new Float32Array(pos.length);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) { nrm[o] += nx; nrm[o + 1] += ny; nrm[o + 2] += nz; }
  }
  for (let i = 0; i < nrm.length; i += 3) {
    const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1;
    nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l;
  }
  mesh.nrm = nrm;
  return mesh;
}

// Voxel indices -> object space (object height spans ±1 before scaling).
export function toWorld(mesh, dims, extents, scale = 1) {
  const [nx, ny, nz] = dims, [ex, ey, ez] = extents, p = mesh.pos;
  for (let i = 0; i < p.length; i += 3) {
    p[i] = (-ex + 2 * ex * p[i] / (nx - 1)) * scale;
    p[i + 1] = (-ey + 2 * ey * p[i + 1] / (ny - 1)) * scale;
    p[i + 2] = (-ez + 2 * ez * p[i + 2] / (nz - 1)) * scale;
  }
  return mesh;
}

// Sample each vertex's colour from the view that sees it most head-on.
export function colorizeMesh(mesh, images, norm, angles, elev = 0, scale = 1) {
  const {pos, nrm} = mesh, n = pos.length / 3, col = new Uint8Array(n * 3).fill(160);
  const dirs = angles.map(th => cameraDir(th, elev * D2R));
  for (let v = 0; v < n; v++) {
    let best = -1, bestDot = 0.05;
    for (let k = 0; k < dirs.length; k++) {
      const d = nrm[v * 3] * dirs[k][0] + nrm[v * 3 + 1] * dirs[k][1] + nrm[v * 3 + 2] * dirs[k][2];
      if (d > bestDot) { bestDot = d; best = k; }
    }
    if (best < 0) continue;
    const im = images[best];
    const {px, py} = project(norm, angles[best], elev * D2R, pos[v * 3] / scale, pos[v * 3 + 1] / scale, pos[v * 3 + 2] / scale);
    const x = clamp(Math.round(px), 0, im.w - 1), y = clamp(Math.round(py), 0, im.h - 1);
    const o = (y * im.w + x) * 4;
    col[v * 3] = im.data[o]; col[v * 3 + 1] = im.data[o + 1]; col[v * 3 + 2] = im.data[o + 2];
  }
  mesh.col = col;
  return mesh;
}

// Full pipeline: turntable photos -> coloured mesh.
export async function reconstruct(images, opts = {}, onProgress) {
  const {heightMM = 32, smooth = 2, blur = 1} = opts;
  const w = images[0].w, h = images[0].h;
  const masks = images.map(im => silhouette(im.data, im.w, im.h, opts));
  const norm = normalizeViews(masks, w, h);
  const vol = await carve(masks, w, h, norm, opts, onProgress);
  const field = blur ? blur3(vol.occ, vol.dims, blur) : vol.occ;
  const mesh = surfaceNets(field, vol.dims, 0.5);
  if (!mesh.idx.length) throw new Error('Nothing survived carving — check the background, threshold, or photo order.');
  smoothMesh(mesh, smooth);
  toWorld(mesh, vol.dims, vol.extents, heightMM / 2);
  computeNormals(mesh);
  colorizeMesh(mesh, images, norm, vol.angles, opts.elev || 0, heightMM / 2);
  return {mesh, masks, norm, dims: vol.dims};
}

/* ============================ mesh I/O ============================ */

export function meshToSTL(mesh) {
  const {pos, idx} = mesh, tri = idx.length / 3;
  const buf = new ArrayBuffer(84 + tri * 50), dv = new DataView(buf);
  new Uint8Array(buf, 0, 80).set(new TextEncoder().encode('MicroMiniger scan'));
  dv.setUint32(80, tri, true);
  for (let t = 0; t < tri; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const o = 84 + t * 50;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    [a, b, c].forEach((v, i) => {
      dv.setFloat32(o + 12 + i * 12, pos[v], true);
      dv.setFloat32(o + 16 + i * 12, pos[v + 1], true);
      dv.setFloat32(o + 20 + i * 12, pos[v + 2], true);
    });
    dv.setUint16(o + 48, 0, true);
  }
  return buf;
}

export function meshToPLY(mesh) {
  const {pos, idx, nrm, col} = mesh, nv = pos.length / 3, nf = idx.length / 3;
  const header = `ply\nformat binary_little_endian 1.0\ncomment MicroMiniger scan\n` +
    `element vertex ${nv}\nproperty float x\nproperty float y\nproperty float z\n` +
    (nrm ? `property float nx\nproperty float ny\nproperty float nz\n` : '') +
    (col ? `property uchar red\nproperty uchar green\nproperty uchar blue\n` : '') +
    `element face ${nf}\nproperty list uchar int vertex_indices\nend_header\n`;
  const hb = new TextEncoder().encode(header);
  const vs = 12 + (nrm ? 12 : 0) + (col ? 3 : 0);
  const buf = new ArrayBuffer(hb.length + nv * vs + nf * 13), dv = new DataView(buf);
  new Uint8Array(buf).set(hb);
  let o = hb.length;
  for (let v = 0; v < nv; v++) {
    dv.setFloat32(o, pos[v * 3], true); dv.setFloat32(o + 4, pos[v * 3 + 1], true); dv.setFloat32(o + 8, pos[v * 3 + 2], true); o += 12;
    if (nrm) { dv.setFloat32(o, nrm[v * 3], true); dv.setFloat32(o + 4, nrm[v * 3 + 1], true); dv.setFloat32(o + 8, nrm[v * 3 + 2], true); o += 12; }
    if (col) { dv.setUint8(o, col[v * 3]); dv.setUint8(o + 1, col[v * 3 + 1]); dv.setUint8(o + 2, col[v * 3 + 2]); o += 3; }
  }
  for (let f = 0; f < nf; f++) {
    dv.setUint8(o, 3);
    dv.setInt32(o + 1, idx[f * 3], true); dv.setInt32(o + 5, idx[f * 3 + 1], true); dv.setInt32(o + 9, idx[f * 3 + 2], true);
    o += 13;
  }
  return buf;
}

export function parseSTL(buf) {
  if (buf.byteLength >= 84) {
    const dv = new DataView(buf), n = dv.getUint32(80, true);
    if (84 + n * 50 === buf.byteLength) {
      const pos = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) { const o = 84 + i * 50 + 12; for (let j = 0; j < 9; j++) pos[i * 9 + j] = dv.getFloat32(o + j * 4, true); }
      return {pos, idx: Uint32Array.from({length: n * 3}, (_, i) => i)};
    }
  }
  const txt = new TextDecoder().decode(buf);
  const vs = [...txt.matchAll(/vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g)];
  const nt = Math.floor(vs.length / 3), pos = new Float32Array(nt * 9);
  for (let i = 0; i < nt * 3; i++) { pos[i * 3] = +vs[i][1]; pos[i * 3 + 1] = +vs[i][2]; pos[i * 3 + 2] = +vs[i][3]; }
  return {pos, idx: Uint32Array.from({length: nt * 3}, (_, i) => i)};
}

const PLY_SIZE = {char:1, uchar:1, int8:1, uint8:1, short:2, ushort:2, int16:2, uint16:2, int:4, uint:4, int32:4, uint32:4, float:4, float32:4, double:8, float64:8};
function plyHeader(buf) {
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 1 << 16)));
  const end = head.indexOf('end_header');
  if (end < 0) throw new Error('Not a PLY file.');
  const offset = head.indexOf('\n', end) + 1;
  const lines = head.slice(0, end).split(/\r?\n/).map(l => l.trim());
  const fmt = (lines.find(l => l.startsWith('format')) || '').split(/\s+/)[1];
  const elements = [];
  for (const l of lines) {
    const p = l.split(/\s+/);
    if (p[0] === 'element') elements.push({name: p[1], count: +p[2], props: []});
    else if (p[0] === 'property' && elements.length) {
      const e = elements[elements.length - 1];
      if (p[1] === 'list') e.props.push({list: true, countType: p[2], type: p[3], name: p[4]});
      else e.props.push({type: p[1], name: p[2]});
    }
  }
  return {fmt, offset, elements};
}
function readerFor(dv, little) {
  return {
    char:(o)=>dv.getInt8(o), uchar:(o)=>dv.getUint8(o), int8:(o)=>dv.getInt8(o), uint8:(o)=>dv.getUint8(o),
    short:(o)=>dv.getInt16(o,little), ushort:(o)=>dv.getUint16(o,little), int16:(o)=>dv.getInt16(o,little), uint16:(o)=>dv.getUint16(o,little),
    int:(o)=>dv.getInt32(o,little), uint:(o)=>dv.getUint32(o,little), int32:(o)=>dv.getInt32(o,little), uint32:(o)=>dv.getUint32(o,little),
    float:(o)=>dv.getFloat32(o,little), float32:(o)=>dv.getFloat32(o,little), double:(o)=>dv.getFloat64(o,little), float64:(o)=>dv.getFloat64(o,little),
  };
}

export function parsePLYMesh(buf) {
  const {fmt, offset, elements} = plyHeader(buf);
  const vE = elements.find(e => e.name === 'vertex'), fE = elements.find(e => e.name === 'face');
  if (!vE) throw new Error('PLY has no vertex element.');
  const nv = vE.count;
  const pos = new Float32Array(nv * 3);
  const hasN = vE.props.some(p => p.name === 'nx'), hasC = vE.props.some(p => p.name === 'red');
  const nrm = hasN ? new Float32Array(nv * 3) : null, col = hasC ? new Uint8Array(nv * 3) : null;
  const idx = [];
  if (fmt === 'ascii') {
    const txt = new TextDecoder().decode(buf).slice(offset).trim().split(/\r?\n/);
    let li = 0;
    for (let v = 0; v < nv; v++) {
      const p = txt[li++].trim().split(/\s+/).map(Number);
      vE.props.forEach((pr, i) => {
        const val = p[i];
        if (pr.name === 'x') pos[v * 3] = val; else if (pr.name === 'y') pos[v * 3 + 1] = val; else if (pr.name === 'z') pos[v * 3 + 2] = val;
        else if (hasN && pr.name === 'nx') nrm[v * 3] = val; else if (hasN && pr.name === 'ny') nrm[v * 3 + 1] = val; else if (hasN && pr.name === 'nz') nrm[v * 3 + 2] = val;
        else if (hasC && pr.name === 'red') col[v * 3] = val; else if (hasC && pr.name === 'green') col[v * 3 + 1] = val; else if (hasC && pr.name === 'blue') col[v * 3 + 2] = val;
      });
    }
    for (let f = 0; f < (fE?.count || 0); f++) {
      const p = txt[li++].trim().split(/\s+/).map(Number);
      for (let t = 1; t + 2 < p[0] + 1; t++) idx.push(p[1], p[t + 1], p[t + 2]);
    }
  } else {
    const little = fmt !== 'binary_big_endian';
    const dv = new DataView(buf), rd = readerFor(dv, little);
    let o = offset;
    for (let v = 0; v < nv; v++) for (const pr of vE.props) {
      const val = rd[pr.type](o); o += PLY_SIZE[pr.type];
      if (pr.name === 'x') pos[v * 3] = val; else if (pr.name === 'y') pos[v * 3 + 1] = val; else if (pr.name === 'z') pos[v * 3 + 2] = val;
      else if (hasN && pr.name === 'nx') nrm[v * 3] = val; else if (hasN && pr.name === 'ny') nrm[v * 3 + 1] = val; else if (hasN && pr.name === 'nz') nrm[v * 3 + 2] = val;
      else if (hasC && pr.name === 'red') col[v * 3] = val; else if (hasC && pr.name === 'green') col[v * 3 + 1] = val; else if (hasC && pr.name === 'blue') col[v * 3 + 2] = val;
    }
    for (let f = 0; f < (fE?.count || 0); f++) for (const pr of fE.props) {
      if (!pr.list) { o += PLY_SIZE[pr.type]; continue; }
      const n = rd[pr.countType](o); o += PLY_SIZE[pr.countType];
      const vs = [];
      for (let i = 0; i < n; i++) { vs.push(rd[pr.type](o)); o += PLY_SIZE[pr.type]; }
      for (let t = 1; t + 1 < n; t++) idx.push(vs[0], vs[t], vs[t + 1]);
    }
  }
  return {pos, idx: new Uint32Array(idx), nrm, col};
}

/* ============================ gaussian splats ============================ */

// Σ = R S Sᵀ Rᵀ, packed as the 6 upper-triangular terms.
function covFromScaleRot(sx, sy, sz, qw, qx, qy, qz, out, o) {
  const n = Math.hypot(qw, qx, qy, qz) || 1;
  const w = qw / n, x = qx / n, y = qy / n, z = qz / n;
  const R = [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
  const s = [sx, sy, sz], M = new Float32Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i * 3 + j] = R[i * 3 + j] * s[j];
  const c = (i, k) => M[i * 3] * M[k * 3] + M[i * 3 + 1] * M[k * 3 + 1] + M[i * 3 + 2] * M[k * 3 + 2];
  out[o] = c(0, 0); out[o + 1] = c(0, 1); out[o + 2] = c(0, 2);
  out[o + 3] = c(1, 1); out[o + 4] = c(1, 2); out[o + 5] = c(2, 2);
}

// antimatter15 .splat: 32 bytes — pos f32×3, scale f32×3, RGBA u8×4, quat u8×4.
export function parseSplat(buf) {
  const n = Math.floor(buf.byteLength / 32), dv = new DataView(buf), u8 = new Uint8Array(buf);
  const pos = new Float32Array(n * 3), cov = new Float32Array(n * 6), col = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 32;
    pos[i * 3] = dv.getFloat32(o, true); pos[i * 3 + 1] = dv.getFloat32(o + 4, true); pos[i * 3 + 2] = dv.getFloat32(o + 8, true);
    covFromScaleRot(dv.getFloat32(o + 12, true), dv.getFloat32(o + 16, true), dv.getFloat32(o + 20, true),
      (u8[o + 28] - 128) / 128, (u8[o + 29] - 128) / 128, (u8[o + 30] - 128) / 128, (u8[o + 31] - 128) / 128, cov, i * 6);
    col.set(u8.subarray(o + 24, o + 28), i * 4);
  }
  return {count: n, pos, cov, col};
}

const SH0 = 0.28209479177387814;
export function parsePLYSplat(buf) {
  const {fmt, offset, elements} = plyHeader(buf);
  const vE = elements.find(e => e.name === 'vertex');
  if (!vE || !vE.props.some(p => p.name === 'f_dc_0')) throw new Error('Not a Gaussian-splat PLY.');
  if (fmt === 'ascii') throw new Error('ASCII splat PLY not supported — export binary.');
  const little = fmt !== 'binary_big_endian';
  const n = vE.count, dv = new DataView(buf), rd = readerFor(dv, little);
  const stride = vE.props.reduce((a, p) => a + PLY_SIZE[p.type], 0);
  const at = {};
  let po = 0;
  for (const p of vE.props) { at[p.name] = {o: po, t: p.type}; po += PLY_SIZE[p.type]; }
  const get = (base, name) => at[name] ? rd[at[name].t](base + at[name].o) : 0;
  const pos = new Float32Array(n * 3), cov = new Float32Array(n * 6), col = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const b = offset + i * stride;
    pos[i * 3] = get(b, 'x'); pos[i * 3 + 1] = get(b, 'y'); pos[i * 3 + 2] = get(b, 'z');
    covFromScaleRot(Math.exp(get(b, 'scale_0')), Math.exp(get(b, 'scale_1')), Math.exp(get(b, 'scale_2')),
      get(b, 'rot_0'), get(b, 'rot_1'), get(b, 'rot_2'), get(b, 'rot_3'), cov, i * 6);
    col[i * 4] = clamp(Math.round((0.5 + SH0 * get(b, 'f_dc_0')) * 255), 0, 255);
    col[i * 4 + 1] = clamp(Math.round((0.5 + SH0 * get(b, 'f_dc_1')) * 255), 0, 255);
    col[i * 4 + 2] = clamp(Math.round((0.5 + SH0 * get(b, 'f_dc_2')) * 255), 0, 255);
    col[i * 4 + 3] = clamp(Math.round(255 / (1 + Math.exp(-get(b, 'opacity')))), 0, 255);
  }
  return {count: n, pos, cov, col};
}

export function isSplatPLY(buf) {
  try { return plyHeader(buf).elements.some(e => e.props.some(p => p.name === 'f_dc_0')); } catch { return false; }
}
export function parseSplatFile(buf, name = '') {
  if (/\.splat$/i.test(name)) return parseSplat(buf);
  if (isSplatPLY(buf)) return parsePLYSplat(buf);
  if (/\.ply$/i.test(name)) throw new Error('This PLY is a mesh, not a splat cloud.');
  return parseSplat(buf);
}

/* ============================ capture export ============================ */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
  return t;
})();
function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
// ponytail: stored (uncompressed) ZIP — JPEGs don't deflate anyway
export function zipStore(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : new Uint8Array(f.data);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((a, p) => a + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], {type: 'application/zip'});
}

// nerfstudio / instant-ngp transforms.json with nominal turntable poses.
export function transformsJSON(names, {w, h, arc = 360, elev = 0, reverse = false, fovDeg = 40, radius = 4} = {}) {
  const fl = 0.5 * w / Math.tan(0.5 * fovDeg * D2R);
  const angles = viewAngles(names.length, arc, reverse);
  const frames = names.map((file_path, k) => {
    const th = angles[k], e = elev * D2R;
    const c = cameraDir(th, e).map(v => v * radius);       // camera position
    const f = cameraDir(th, e).map(v => -v);               // forward (camera looks at origin)
    const r = [Math.sin(th), 0, -Math.cos(th)];            // right
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const b = [-f[0], -f[1], -f[2]];                       // OpenGL: camera looks down -Z
    return {file_path, transform_matrix: [
      [r[0], u[0], b[0], c[0]],
      [r[1], u[1], b[1], c[1]],
      [r[2], u[2], b[2], c[2]],
      [0, 0, 0, 1],
    ]};
  });
  return JSON.stringify({camera_model: 'OPENCV', fl_x: fl, fl_y: fl, cx: w / 2, cy: h / 2, w, h, k1: 0, k2: 0, p1: 0, p2: 0,
    aabb_scale: 2, comment: 'Nominal turntable poses from MicroMiniger — re-run SfM for best quality.', frames}, null, 1);
}

export const CAPTURE_README = `MicroMiniger capture set
========================
images/        the photos, in turntable order
transforms.json  nominal camera poses (nerfstudio / instant-ngp format)

These poses assume an even turntable sweep with the camera level and the mini
centred. They are a starting point — every serious pipeline below runs its own
structure-from-motion and will do better:

  Postshot (Windows, GUI)   drag the images/ folder in, train "Splat 3DGS",
                            export .ply or .splat, then import it back here.
  nerfstudio                ns-process-data images --data images --output-dir .
                            ns-train splatfacto --data .
                            ns-export gaussian-splat --load-config <cfg> --output-dir .
  COLMAP + 3DGS (original)  colmap automatic_reconstructor, then train.
  Luma / Polycam (phone)    capture there, export .ply, import back here.

Import the resulting .ply or .splat under 3D Models to view and orbit it in
MicroMiniger, and link it to the mini it came from.

Capture tips for miniatures
  - plain, evenly lit backdrop that contrasts the model (grey/blue paper works)
  - 24-48 photos per full rotation, plus a second ring from ~30 degrees above
  - keep focus and exposure locked; a phone macro lens plus a lazy susan is enough
  - no moving shadows: light the mini, not the turntable
`;

/* ============================ viewers ============================ */

function compile(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}
function lookAt(eye, target, up) {
  const z = [eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]];
  let l = Math.hypot(...z) || 1; z[0] /= l; z[1] /= l; z[2] /= l;
  const x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
  l = Math.hypot(...x) || 1; x[0] /= l; x[1] /= l; x[2] /= l;
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return new Float32Array([
    x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]),
    -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
    -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]), 1,
  ]);
}

class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {antialias: true, preserveDrawingBuffer: true, alpha: false});
    if (!this.gl) throw new Error('WebGL2 is not available in this browser.');
    this.yaw = 0.6; this.pitch = -0.25; this.dist = 3; this.target = [0, 0, 0]; this.upFlip = false;
    let last = null;
    const down = e => { last = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); };
    const up = () => last = null;
    const move = e => {
      if (!last) return;
      if (e.shiftKey) {
        this.target[1] += (e.clientY - last[1]) * this.dist * 0.002;
      } else {
        this.yaw += (e.clientX - last[0]) * 0.01;
        this.pitch = clamp(this.pitch + (e.clientY - last[1]) * 0.01, -1.5, 1.5);
      }
      last = [e.clientX, e.clientY]; this.draw();
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('wheel', e => { e.preventDefault(); this.dist *= e.deltaY < 0 ? 0.9 : 1.1; this.draw(); }, {passive: false});
  }
  camera() {
    const cp = Math.cos(this.pitch), s = this.upFlip ? -1 : 1;
    const eye = [
      this.target[0] + this.dist * cp * Math.sin(this.yaw),
      this.target[1] + this.dist * Math.sin(this.pitch) * s,
      this.target[2] + this.dist * cp * Math.cos(this.yaw),
    ];
    return lookAt(eye, this.target, [0, s, 0]);
  }
  frameBounds(pos, count) {
    let mn = [1e30, 1e30, 1e30], mx = [-1e30, -1e30, -1e30];
    for (let i = 0; i < count; i++) for (let a = 0; a < 3; a++) {
      const v = pos[i * 3 + a];
      if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v;
    }
    this.target = [0, 1, 2].map(a => (mn[a] + mx[a]) / 2);
    this.dist = Math.max(...[0, 1, 2].map(a => mx[a] - mn[a])) * 1.8 || 3;
  }
}

const MESH_VS = `#version 300 es
in vec3 aPos; in vec3 aNrm; in vec3 aCol;
uniform mat4 uView, uProj;
out vec3 vN; out vec3 vC;
void main(){ vN = aNrm; vC = aCol; gl_Position = uProj * uView * vec4(aPos,1.0); }`;
const MESH_FS = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vC; out vec4 o;
uniform int uShade;
void main(){
  vec3 n = normalize(vN);
  float d = 0.35 + 0.65 * max(dot(n, normalize(vec3(0.4,0.8,0.5))), 0.0);
  vec3 base = uShade == 1 ? vC : vec3(0.62,0.68,0.78);
  o = vec4(base * d, 1.0);
}`;

export class MeshView extends Viewer {
  constructor(canvas) {
    super(canvas);
    const gl = this.gl;
    this.prog = compile(gl, MESH_VS, MESH_FS);
    this.vao = gl.createVertexArray();
    this.buf = {pos: gl.createBuffer(), nrm: gl.createBuffer(), col: gl.createBuffer(), idx: gl.createBuffer()};
    gl.enable(gl.DEPTH_TEST);
  }
  load(mesh) {
    const gl = this.gl;
    let {pos, idx, nrm, col} = mesh;
    if (!nrm) { const t = computeNormals({pos, idx}); nrm = t.nrm; }
    this.count = idx.length;
    this.hasCol = !!col;
    gl.bindVertexArray(this.vao);
    const attr = (name, buf, data, size, type, norm) => {
      const loc = gl.getAttribLocation(this.prog, name);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, type, norm, 0, 0);
    };
    attr('aPos', this.buf.pos, pos, 3, gl.FLOAT, false);
    attr('aNrm', this.buf.nrm, nrm, 3, gl.FLOAT, false);
    attr('aCol', this.buf.col, col || new Uint8Array(pos.length), 3, gl.UNSIGNED_BYTE, true);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buf.idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.frameBounds(pos, pos.length / 3);
    this.draw();
  }
  draw() {
    const gl = this.gl, c = this.canvas;
    gl.viewport(0, 0, c.width, c.height);
    gl.clearColor(0.08, 0.09, 0.1, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.count) return;
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'uView'), false, this.camera());
    gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'uProj'), false, perspective(0.8, c.width / c.height, this.dist * 0.01, this.dist * 10));
    gl.uniform1i(gl.getUniformLocation(this.prog, 'uShade'), this.hasCol ? 1 : 0);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }
}

const SPLAT_VS = `#version 300 es
precision highp float; precision highp int;
uniform highp sampler2D uData;
uniform mat4 uView, uProj;
uniform vec2 uFocal, uViewport;
in vec2 aCorner; in uint aIdx;
out vec4 vCol; out vec2 vPos;
void main(){
  int base = int(aIdx) * 3;
  int W = textureSize(uData, 0).x;
  vec4 t0 = texelFetch(uData, ivec2(base % W, base / W), 0);
  vec4 t1 = texelFetch(uData, ivec2((base+1) % W, (base+1) / W), 0);
  vec4 t2 = texelFetch(uData, ivec2((base+2) % W, (base+2) / W), 0);
  vec4 cam = uView * vec4(t0.xyz, 1.0);
  if (cam.z > -0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec4 clip = uProj * cam;
  mat3 Vrk = mat3(t1.x, t1.y, t1.z, t1.y, t1.w, t2.x, t1.z, t2.x, t2.y);
  mat3 J = mat3(
    uFocal.x / cam.z, 0.0, -(uFocal.x * cam.x) / (cam.z * cam.z),
    0.0, uFocal.y / cam.z, -(uFocal.y * cam.y) / (cam.z * cam.z),
    0.0, 0.0, 0.0);
  mat3 T = transpose(mat3(uView)) * J;
  mat3 cov = transpose(T) * Vrk * T;
  float a = cov[0][0] + 0.3, b = cov[0][1], d = cov[1][1] + 0.3;
  float mid = 0.5 * (a + d), rad = length(vec2((a - d) * 0.5, b));
  float l1 = mid + rad, l2 = max(mid - rad, 0.1);
  if (l1 < 0.15) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 e1 = normalize(vec2(b, l1 - a));
  vec2 v1 = min(sqrt(2.0 * l1), 1024.0) * e1;
  vec2 v2 = min(sqrt(2.0 * l2), 1024.0) * vec2(e1.y, -e1.x);
  float rg = t2.z, ba = t2.w;
  vCol = vec4(floor(rg / 256.0), mod(rg, 256.0), floor(ba / 256.0), mod(ba, 256.0)) / 255.0;
  vPos = aCorner;
  vec2 c2 = clip.xy / clip.w;
  gl_Position = vec4(c2 + (aCorner.x * v1 + aCorner.y * v2) / uViewport * 2.0, 0.0, 1.0);
}`;
const SPLAT_FS = `#version 300 es
precision highp float;
in vec4 vCol; in vec2 vPos; out vec4 o;
void main(){
  float A = -dot(vPos, vPos) * 2.0;
  if (A < -4.0) discard;
  float al = exp(A) * vCol.a;
  o = vec4(vCol.rgb * al, al);
}`;

export class SplatView extends Viewer {
  constructor(canvas) {
    super(canvas);
    const gl = this.gl;
    this.prog = compile(gl, SPLAT_VS, SPLAT_FS);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const cl = gl.getAttribLocation(this.prog, 'aCorner');
    gl.enableVertexAttribArray(cl); gl.vertexAttribPointer(cl, 2, gl.FLOAT, false, 0, 0);
    this.idxBuf = gl.createBuffer();
    const il = gl.getAttribLocation(this.prog, 'aIdx');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.idxBuf);
    gl.enableVertexAttribArray(il); gl.vertexAttribIPointer(il, 1, gl.UNSIGNED_INT, 0, 0);
    gl.vertexAttribDivisor(il, 1);
    gl.bindVertexArray(null);
    this.tex = gl.createTexture();
    this.upFlip = true;
  }
  load(splat) {
    const gl = this.gl, {count, pos, cov, col} = splat;
    this.count = count; this.pos = pos;
    const W = 1024, texels = count * 3, H = Math.ceil(texels / W);
    const data = new Float32Array(W * H * 4);
    for (let i = 0; i < count; i++) {
      let o = i * 12;
      data[o] = pos[i * 3]; data[o + 1] = pos[i * 3 + 1]; data[o + 2] = pos[i * 3 + 2]; data[o + 3] = 0;
      data[o + 4] = cov[i * 6]; data[o + 5] = cov[i * 6 + 1]; data[o + 6] = cov[i * 6 + 2]; data[o + 7] = cov[i * 6 + 3];
      data[o + 8] = cov[i * 6 + 4]; data[o + 9] = cov[i * 6 + 5];
      data[o + 10] = col[i * 4] * 256 + col[i * 4 + 1];       // exact for ints < 2^24
      data[o + 11] = col[i * 4 + 2] * 256 + col[i * 4 + 3];
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, W, H, 0, gl.RGBA, gl.FLOAT, data);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
    this.order = new Uint32Array(count);
    this.depth = new Float32Array(count);
    this.frameBounds(pos, count);
    this.sort(); this.draw();
  }
  // ponytail: counting sort on the main thread; move to a worker if huge scans stutter
  sort() {
    const v = this.camera(), n = this.count, d = this.depth;
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < n; i++) {
      const z = v[2] * this.pos[i * 3] + v[6] * this.pos[i * 3 + 1] + v[10] * this.pos[i * 3 + 2] + v[14];
      d[i] = z; if (z < mn) mn = z; if (z > mx) mx = z;
    }
    const B = 65536, counts = new Uint32Array(B + 1), scale = (B - 1) / ((mx - mn) || 1);
    const key = new Uint16Array(n);
    for (let i = 0; i < n; i++) { const k = ((d[i] - mn) * scale) | 0; key[i] = k; counts[k]++; }
    let sum = 0;
    for (let b = 0; b < B; b++) { const c = counts[b]; counts[b] = sum; sum += c; }
    for (let i = 0; i < n; i++) this.order[counts[key[i]]++] = i;   // ascending z = far first
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.idxBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.order, gl.DYNAMIC_DRAW);
    this.sortedAt = [this.yaw, this.pitch, this.dist];
  }
  draw() {
    const gl = this.gl, c = this.canvas;
    if (this.count && (!this.sortedAt || Math.abs(this.sortedAt[0] - this.yaw) > 0.08 || Math.abs(this.sortedAt[1] - this.pitch) > 0.08)) this.sort();
    gl.viewport(0, 0, c.width, c.height);
    gl.clearColor(0.08, 0.09, 0.1, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.count) return;
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.prog);
    const fovy = 0.8, fy = 0.5 * c.height / Math.tan(fovy / 2);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'uView'), false, this.camera());
    gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'uProj'), false, perspective(fovy, c.width / c.height, this.dist * 0.01, this.dist * 20));
    gl.uniform2f(gl.getUniformLocation(this.prog, 'uFocal'), fy, fy);
    gl.uniform2f(gl.getUniformLocation(this.prog, 'uViewport'), c.width, c.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(gl.getUniformLocation(this.prog, 'uData'), 0);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    gl.bindVertexArray(null);
  }
}

/* ============================ self-check ============================ */

export function selfTest() {
  const fails = [];
  const ck = (c, m) => { if (!c) fails.push(m); };
  // silhouette: white frame, dark blob in the middle, one speck
  const w = 40, h = 40, px = new Uint8ClampedArray(w * h * 4).fill(255);
  const set = (x, y, v) => { const o = (y * w + x) * 4; px[o] = px[o + 1] = px[o + 2] = v; };
  for (let y = 10; y < 30; y++) for (let x = 12; x < 28; x++) set(x, y, 20);
  for (let y = 18; y < 22; y++) for (let x = 18; x < 22; x++) set(x, y, 255);  // hole
  set(3, 3, 0);                                                                // speck
  const m = silhouette(px, w, h);
  ck(m[20 * w + 20] === 1, 'silhouette: hole not filled');
  ck(m[3 * w + 3] === 0, 'silhouette: speck not removed');
  ck(m[2 * w + 2] === 0, 'silhouette: background marked');
  // surface nets on an analytic sphere -> vertices sit on the sphere
  const N = 32, f = new Float32Array(N * N * N), R = 0.62;
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const p = [x, y, z].map(v => 2 * v / (N - 1) - 1);
    f[x + N * y + N * N * z] = R - Math.hypot(...p) + 0.5;
  }
  const sp = surfaceNets(f, [N, N, N], 0.5);
  ck(sp.idx.length > 0, 'surfaceNets: no triangles');
  let worst = 0;
  for (let i = 0; i < sp.pos.length; i += 3) {
    const p = [sp.pos[i], sp.pos[i + 1], sp.pos[i + 2]].map(v => 2 * v / (N - 1) - 1);
    worst = Math.max(worst, Math.abs(Math.hypot(...p) - R));
  }
  ck(worst < 2.5 / N, `surfaceNets: sphere off by ${worst.toFixed(3)}`);
  // covariance of an unrotated splat is diag(s^2)
  const cov = new Float32Array(6);
  covFromScaleRot(2, 3, 4, 1, 0, 0, 0, cov, 0);
  ck(Math.abs(cov[0] - 4) < 1e-4 && Math.abs(cov[3] - 9) < 1e-4 && Math.abs(cov[5] - 16) < 1e-4 && Math.abs(cov[1]) < 1e-6,
    'covFromScaleRot: wrong covariance');
  return fails;
}
