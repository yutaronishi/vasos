/* =========================================================
   MODO ESTEIRA — câmera fixa, peças passando em fluxo contínuo.
   Tudo por código (visão computacional clássica, sem IA):
   1. subtração de fundo  → separa a peça da esteira vazia
   2. componentes conexos → cada peça vira uma "mancha"
   3. rastreamento        → acompanha cada peça entre quadros
   4. linha de contagem   → conta uma vez quando a peça cruza a linha
   5. medição             → altura / largura / base em cm (escala calibrada)
   6. silhueta + medidas  → compara com o catálogo e escolhe o modelo
   7. cor                 → Lab corrigido pelo fundo, comparado com a paleta
   ========================================================= */
'use strict';

const EST_W = 320;          // largura da imagem de processamento (px)
const EST_BINS = 24;        // fatias da silhueta (de cima para baixo)

const Esteira = (() => {
  const S = {
    rodando: false, raf: 0, ultimoProc: 0,
    proc: document.createElement('canvas'), pctx: null,
    tela: null, tctx: null,
    W: 0, H: 0, fundo: null, escala: 0,
    mask: null, tmp: null, lab: null,
    tracks: [], proxId: 1,
    contagem: {}, total: 0, ultimas: [],
    modoCal: null, escBase: null,
    perfis: new Map(), perfisCarregados: false,
    silReais: new Map(),   // contornos de peças reais confirmadas (foto na mão): base -> [{p, asp}]
    fps: 0, nQuadros: 0, tFps: 0, ultimoEnvio: 0,
    wakeLock: null,
    cfg: { limiar: 60, minArea: 2, linha: 50, confMin: 50, registrar: true, sempreFoto: false, sombra: false, mascara: false }
  };
  S.pctx = S.proc.getContext('2d', { willReadFrequently: true });

  /* ---------- cores da esteira (calibração própria, separada do modo celular) ---------- */
  const CoresEst = Object.create(Cores);
  CoresEst.refs = {};
  CoresEst.carregar = async function () {
    this.refs = {};
    for (const [c, [nome, hex]] of Object.entries(CORES_PADRAO)) { const [L, a, b] = rgb2lab(...hex2rgb(hex)); this.refs[c] = { nome, L, a, b, s: null, hex, n: 0 }; }
    const cal = await DB.ler('kv', 'cores_est');
    if (cal) for (const [c, r] of Object.entries(cal)) this.refs[c] = { ...(this.refs[c] || { nome: c }), ...r };
  };
  CoresEst.salvarSem = async function (cor) { const cal = {}; for (const [c, r] of Object.entries(this.refs)) if (r.n > 0 && c !== cor) cal[c] = r; await DB.gravar('kv', cal, 'cores_est'); };

  /* ---------- configuração ---------- */
  function lerCfg() { try { Object.assign(S.cfg, JSON.parse(localStorage.getItem('vasos.est') || '{}')); } catch (_) {} }
  function salvarCfg() { try { localStorage.setItem('vasos.est', JSON.stringify(S.cfg)); } catch (_) {} }

  /* ---------- silhuetas do catálogo (pasta treino/) ---------- */
  async function carregarPerfis() {
    if (S.perfisCarregados) return;
    S.perfisCarregados = true;
    try {
      const lista = await (await fetch('treino/index.json')).json();
      const c = document.createElement('canvas'), ctx = c.getContext('2d', { willReadFrequently: true });
      for (const it of lista) {
        try {
          const img = await carregarImagem('treino/' + it.arquivo);
          c.width = img.width; c.height = img.height; ctx.clearRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0);
          const d = ctx.getImageData(0, 0, c.width, c.height).data, W = c.width, H = c.height;
          const L = new Int32Array(H).fill(-1), R = new Int32Array(H).fill(-1);
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 128) { if (L[y] < 0) L[y] = x; R[y] = x; }
          let y0 = 0, y1 = H - 1; while (y0 < H && L[y0] < 0) y0++; while (y1 > y0 && L[y1] < 0) y1--;
          const larg = []; for (let y = y0; y <= y1; y++) larg.push(L[y] < 0 ? 0 : R[y] - L[y] + 1);
          S.perfis.set(it.base, { p: perfilDe(larg), asp: larg.length / Math.max(1, ...larg) });   // asp = altura/largura na foto do catálogo
        } catch (_) { /* imagem com problema: segue sem silhueta */ }
      }
    } catch (e) { console.warn('silhuetas', e); }
    status();
  }
  // perfil = largura máxima em cada fatia / largura máxima total
  function perfilDe(larguras) {
    const n = larguras.length, max = Math.max(1, ...larguras), p = new Float32Array(EST_BINS);
    for (let k = 0; k < EST_BINS; k++) {
      const a = Math.floor(k * n / EST_BINS), b = Math.max(a + 1, Math.floor((k + 1) * n / EST_BINS));
      let m = 0; for (let i = a; i < b && i < n; i++) if (larguras[i] > m) m = larguras[i];
      p[k] = m / max;
    }
    return p;
  }

  /* ---------- quadros ---------- */
  function prepararTamanho() {
    const vw = video.videoWidth, vh = video.videoHeight; if (!vw) return false;
    const W = EST_W, H = Math.round(vh * W / vw);
    if (W !== S.W || H !== S.H) {
      S.W = W; S.H = H; S.proc.width = W; S.proc.height = H;
      S.mask = new Uint8Array(W * H); S.tmp = new Uint8Array(W * H); S.lab = new Int32Array(W * H);
      if (S.fundo && S.fundo.length !== W * H * 3) { S.fundo = null; toast('A imagem mudou de tamanho — calibre o fundo de novo'); }
    }
    const tw = Math.min(960, vw);
    if (S.tela.width !== tw) { S.tela.width = tw; S.tela.height = Math.round(vh * tw / vw); }
    return true;
  }
  function lerQuadro() { S.pctx.drawImage(video, 0, 0, S.W, S.H); return S.pctx.getImageData(0, 0, S.W, S.H).data; }

  async function calibrarFundo() {
    if (!Cam.stream) await Cam.ligar();
    for (let i = 0; i < 40 && !Cam.pronta(); i++) await sleep(100);
    if (!Cam.pronta() || !prepararTamanho()) { toast('Câmera não está pronta'); return; }
    const pausado = S.rodando; S.rodando = false;
    $('#estStatus').textContent = 'Calibrando o fundo — mantenha a esteira vazia…';
    const N = S.W * S.H, n = 20, soma = new Float32Array(N * 3);
    for (let k = 0; k < n; k++) {
      const d = lerQuadro();
      for (let p = 0, i = 0, j = 0; p < N; p++, i += 4, j += 3) { soma[j] += d[i]; soma[j + 1] += d[i + 1]; soma[j + 2] += d[i + 2]; }
      await sleep(70);
    }
    for (let j = 0; j < soma.length; j++) soma[j] /= n;
    S.fundo = soma;
    await salvarCalibracao();
    await travarCamera(true);
    toast('Fundo calibrado');
    S.rodando = pausado; if (pausado) loop();
    status();
  }

  async function salvarCalibracao() {
    await DB.gravar('kv', { W: S.W, H: S.H, fundo: S.fundo ? S.fundo.buffer.slice(0) : null, escala: S.escala }, 'esteira');
  }
  async function lerCalibracao() {
    const c = await DB.ler('kv', 'esteira'); if (!c) return;
    S.escala = c.escala || 0;
    if (c.fundo) { S.W = c.W; S.H = c.H; S.fundo = new Float32Array(c.fundo); S.mask = new Uint8Array(c.W * c.H); S.tmp = new Uint8Array(c.W * c.H); S.lab = new Int32Array(c.W * c.H); S.proc.width = c.W; S.proc.height = c.H; }
  }

  async function travarCamera(silencioso) {
    const t = Cam.stream && Cam.stream.getVideoTracks()[0]; if (!t || !t.getCapabilities) { if (!silencioso) toast('Recurso não disponível neste navegador'); return; }
    const cap = t.getCapabilities(), st = t.getSettings(), adv = {};
    if (cap.exposureMode && cap.exposureMode.includes('manual') && st.exposureTime) { adv.exposureMode = 'manual'; adv.exposureTime = st.exposureTime; }
    if (cap.whiteBalanceMode && cap.whiteBalanceMode.includes('manual') && st.colorTemperature) { adv.whiteBalanceMode = 'manual'; adv.colorTemperature = st.colorTemperature; }
    if (cap.focusMode && cap.focusMode.includes('manual') && st.focusDistance != null) { adv.focusMode = 'manual'; adv.focusDistance = st.focusDistance; }
    if (!Object.keys(adv).length) { if (!silencioso) toast('Este celular não deixa travar a câmera pelo navegador — o app compensa pelo fundo'); return; }
    try { await t.applyConstraints({ advanced: [adv] }); if (!silencioso) toast('Câmera travada'); }
    catch (e) { if (!silencioso) toast('Não consegui travar: ' + e.message); }
  }

  /* ---------- morfologia binária (janela quadrada, via somas) ---------- */
  function morf(m, out, W, H, r, dilatar, tmp) {
    const hor = tmp || S.tmp;
    for (let y = 0; y < H; y++) {
      let s = 0; const o = y * W;
      for (let x = -r; x <= r; x++) if (x >= 0 && x < W) s += m[o + x];
      for (let x = 0; x < W; x++) {
        const cont = Math.min(W - 1, x + r) - Math.max(0, x - r) + 1;
        hor[o + x] = dilatar ? (s > 0 ? 1 : 0) : (s === cont ? 1 : 0);
        const sai = x - r, entra = x + r + 1;
        if (sai >= 0) s -= m[o + sai]; if (entra < W) s += m[o + entra];
      }
    }
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) if (y >= 0 && y < H) s += hor[y * W + x];
      for (let y = 0; y < H; y++) {
        const cont = Math.min(H - 1, y + r) - Math.max(0, y - r) + 1;
        out[y * W + x] = dilatar ? (s > 0 ? 1 : 0) : (s === cont ? 1 : 0);
        const sai = y - r, entra = y + r + 1;
        if (sai >= 0) s -= hor[sai * W + x]; if (entra < H) s += hor[entra * W + x];
      }
    }
  }

  /* ---------- processamento de um quadro ---------- */
  function processar() {
    const d = lerQuadro(), W = S.W, H = S.H, N = W * H, F = S.fundo, m = S.mask;
    // 1) ganho de brilho (mediana da razão atual/fundo) — compensa a exposição automática
    const razoes = [];
    for (let p = 0; p < N; p += 7) { const i = p * 4, j = p * 3, b = F[j] + F[j + 1] + F[j + 2]; if (b > 30) razoes.push((d[i] + d[i + 1] + d[i + 2]) / b); }
    razoes.sort((a, b) => a - b);
    const g = razoes.length ? Math.max(0.3, Math.min(3, razoes[razoes.length >> 1])) : 1;
    // 2) máscara: pixel diferente do fundo = peça
    const lim = S.cfg.limiar;
    for (let p = 0, i = 0, j = 0; p < N; p++, i += 4, j += 3) {
      const r = d[i] / g, gg = d[i + 1] / g, b = d[i + 2] / g;
      let fg = Math.abs(r - F[j]) + Math.abs(gg - F[j + 1]) + Math.abs(b - F[j + 2]) > lim;
      if (fg && S.cfg.sombra) {
        const sa = r + gg + b + 1, sb = F[j] + F[j + 1] + F[j + 2] + 1, k = sa / sb;
        if (k > 0.35 && k < 0.92 && Math.abs(r / sa - F[j] / sb) + Math.abs(gg / sa - F[j + 1] / sb) < 0.04) fg = false;
      }
      m[p] = fg ? 1 : 0;
    }
    // 3) limpeza: fecha buracos (dilata/erode 2) e tira ruído (erode/dilata 1)
    const a = new Uint8Array(N);
    morf(m, a, W, H, 2, true); morf(a, m, W, H, 2, false);
    morf(m, a, W, H, 1, false); morf(a, m, W, H, 1, true);
    // 4) componentes conexos
    const lab = S.lab; lab.fill(0);
    const comps = [], minArea = N * S.cfg.minArea / 100, pilha = new Int32Array(N);
    let id = 0;
    for (let p0 = 0; p0 < N; p0++) {
      if (!m[p0] || lab[p0]) continue;
      id++; let topo = 0, area = 0, sx = 0, sy = 0, x0 = W, x1 = 0, y0 = H, y1 = 0;
      pilha[topo++] = p0; lab[p0] = id;
      while (topo) {
        const p = pilha[--topo], x = p % W, y = (p / W) | 0;
        area++; sx += x; sy += y; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && m[p - 1] && !lab[p - 1]) { lab[p - 1] = id; pilha[topo++] = p - 1; }
        if (x < W - 1 && m[p + 1] && !lab[p + 1]) { lab[p + 1] = id; pilha[topo++] = p + 1; }
        if (y > 0 && m[p - W] && !lab[p - W]) { lab[p - W] = id; pilha[topo++] = p - W; }
        if (y < H - 1 && m[p + W] && !lab[p + W]) { lab[p + W] = id; pilha[topo++] = p + W; }
      }
      if (area >= minArea) comps.push({ id, area, cx: sx / area, cy: sy / area, x0, x1, y0, y1 });
    }
    // 5) ganho por canal para a cor (fundo calibrado / fundo atual, só onde não tem peça)
    const sF = [0, 0, 0], sC = [0, 0, 0];
    for (let p = 0; p < N; p += 3) if (!m[p]) { const i = p * 4, j = p * 3; sF[0] += F[j]; sF[1] += F[j + 1]; sF[2] += F[j + 2]; sC[0] += d[i]; sC[1] += d[i + 1]; sC[2] += d[i + 2]; }
    const ganhos = sF.map((v, k) => sC[k] > 0 ? v / sC[k] : 1);
    return { d, comps, ganhos };
  }

  /* ---------- medição de uma peça ---------- */
  function observar(c, d, ganhos) { return observarEm(S.lab, S.W, S.H, c, d, ganhos); }
  function observarEm(lab, W, H, c, d, ganhos) {
    const n = c.y1 - c.y0 + 1;
    const L = new Int32Array(n).fill(-1), R = new Int32Array(n).fill(-1);
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (lab[y * W + x] === c.id) { const k = y - c.y0; if (L[k] < 0) L[k] = x; R[k] = x; }
    const larg = Array.from(L, (l, k) => l < 0 ? 0 : R[k] - l + 1);
    const media = (a, b) => { let s = 0, q = 0; for (let k = Math.floor(a); k < Math.max(Math.floor(a) + 1, Math.floor(b)); k++) if (larg[k]) { s += larg[k]; q++; } return q ? s / q : 0; };
    const Wmax = Math.max(1, ...larg);
    // cor: miolo da peça (25–75% da altura, 20–80% da largura de cada linha)
    const px = [];
    for (let k = Math.floor(n * 0.25); k < Math.floor(n * 0.75); k++) {
      if (L[k] < 0) continue; const w = R[k] - L[k], y = c.y0 + k;
      for (let x = Math.round(L[k] + w * 0.2); x <= Math.round(R[k] - w * 0.2); x++) {
        const p = y * W + x; if (lab[p] !== c.id) continue; const i = p * 4;
        px.push(Math.min(255, d[i] * ganhos[0]), Math.min(255, d[i + 1] * ganhos[1]), Math.min(255, d[i + 2] * ganhos[2]), 255);
      }
    }
    const cor = px.length ? medirCor({ data: px }) : { L: 50, a: 0, b: 0, s: 0, hex: '#888888' };
    return {
      Hpx: n, Wmax, Wtopo: media(0, n * 0.08), Wbase: media(n * 0.94, n),
      perfil: perfilDe(larg), cor,
      toca: c.x0 <= 1 || c.x1 >= W - 2 || c.y0 <= 1 || c.y1 >= H - 2,
      caixa: { x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1 }
    };
  }

  /* ---------- identificação: medidas + silhueta → modelo ---------- */
  function classificar(o, usarEscala = true) {
    const temEscala = usarEscala && S.escala > 0, res = [];
    const H = o.Hpx / S.escala, Wm = o.Wmax / S.escala, Wb = o.Wbase / S.escala;
    for (const b of Cat.bases.values()) {
      const dm = b.dim; if (!dm || !dm.alt) continue;
      // pesos: altura é a medida mais confiável numa vista lateral; a largura varia com o giro
      // da peça (quadrados mostram a diagonal) e a base quase nunca aparece inteira de lado
      const pf = S.perfis.get(b.base);
      let s;
      if (temEscala) {
        const eH = Math.abs(H - dm.alt) / dm.alt;
        const eW = dm.larg.length ? Math.min(...dm.larg.map(l => Math.abs(Wm - l) / l)) : 0.3;
        const eB = dm.base.length ? Math.min(...dm.base.map(l => Math.abs(Wb - l) / l)) : 0;
        s = 2.0 * eH + 0.5 * eW + 0.1 * eB;
      } else {
        // sem escala: proporção altura/largura — de preferência a da foto do catálogo (mesmo ângulo de foto)
        const asp = o.Hpx / o.Wmax, aspC = pf ? pf.asp : dm.alt / (dm.larg[0] || dm.alt);
        s = Math.abs(Math.log(asp / aspC));
      }
      if (pf) { let e = 0; for (let k = 0; k < EST_BINS; k++) e += Math.abs(pf.p[k] - o.perfil[k]); s += 3.0 * e / EST_BINS; }
      else s += temEscala ? 0.15 : 0.5;   // sem silhueta no catálogo: penaliza
      // contornos reais já confirmados para esse modelo (mesmo ângulo de foto): vale o mais parecido
      if (!temEscala && S.silReais.has(b.base)) {
        for (const r of S.silReais.get(b.base)) {
          let e = 0; for (let k = 0; k < EST_BINS; k++) e += Math.abs(r.p[k] - o.perfil[k]);
          const sr = Math.abs(Math.log((o.Hpx / o.Wmax) / r.asp)) + 3.0 * e / EST_BINS;
          if (sr < s) s = sr;
        }
      }
      res.push({ base: b.base, s });
    }
    res.sort((a, b) => a.s - b.s);
    const top = res.slice(0, 8); if (!top.length) return [];
    const w = top.map(r => Math.exp(-(r.s - top[0].s) / 0.05)), tot = w.reduce((a, b) => a + b, 0);
    return top.map((r, i) => ({ ...r, p: w[i] / tot }));
  }

  function identificar(o) {
    // 1º o formato decide o modelo; depois a cor é escolhida só entre as cores possíveis desse modelo
    const modelos = classificar(o), sug = [];
    for (const m of modelos.slice(0, 5)) {
      const ops = Cat.opcoesCor(m.base), possiveis = ops.map(x => x.cor).filter(Boolean);
      const cl = possiveis.length ? CoresEst.classificar(o.cor, possiveis) : [];
      const pc = Object.fromEntries(cl.map(c => [c.cor, c])) ;
      for (const op of ops) {
        const c = op.cor ? pc[op.cor] : null, pC = op.cor ? (c ? c.p : 0) : 1;
        sug.push({ ...op, base: m.base, pModelo: m.p, pCor: pC, distCor: c ? c.d : 0, erro: m.s, p: m.p * (0.3 + 0.7 * pC) * (op.emLinha ? 1 : 0.8) });
      }
    }
    sug.sort((a, b) => b.p - a.p);
    return { top: sug[0] || null, modelos };
  }

  /* ---------- rastreamento e contagem ---------- */
  function rastrear(comps, d, ganhos) {
    const W = S.W, maxD = W * 0.25, linhaX = W * S.cfg.linha / 100;
    const pares = [];
    for (const t of S.tracks) for (const c of comps) { const dist = Math.hypot(t.cx - c.cx, t.cy - c.cy); if (dist < maxD) pares.push({ t, c, dist }); }
    pares.sort((a, b) => a.dist - b.dist);
    const usT = new Set(), usC = new Set();
    for (const { t, c } of pares) {
      if (usT.has(t) || usC.has(c)) continue; usT.add(t); usC.add(c);
      t.prevCx = t.cx; t.cx = c.cx; t.cy = c.cy; t.comp = c; t.perdido = 0; t.visto = true;
    }
    for (const t of S.tracks) if (!usT.has(t)) { t.perdido++; t.visto = false; t.comp = null; }
    for (const c of comps) if (!usC.has(c)) S.tracks.push({ id: S.proxId++, cx: c.cx, cy: c.cy, prevCx: null, comp: c, perdido: 0, visto: true, contado: false, melhor: null, melhorDist: Infinity, rotulo: '' });
    S.tracks = S.tracks.filter(t => t.perdido <= 6);

    for (const t of S.tracks) {
      if (!t.visto) continue;
      // guarda a melhor visão da peça: inteira na imagem e mais perto do centro
      const c = t.comp, toca = c.x0 <= 1 || c.x1 >= W - 2 || c.y0 <= 1 || c.y1 >= S.H - 2;
      const dist = Math.abs(t.cx - W / 2);
      if (!toca && dist < t.melhorDist) { t.melhorDist = dist; t.melhor = observar(c, d, ganhos); t.melhorCaixa = { ...c }; }
      if (!t.contado && t.prevCx !== null && ((t.prevCx < linhaX && t.cx >= linhaX) || (t.prevCx > linhaX && t.cx <= linhaX))) {
        t.contado = true;
        const obs = t.melhor || observar(c, d, ganhos);
        contar(t, obs);
      }
    }
  }

  function recorte(caixa, max) {
    const sx = video.videoWidth / S.W, sy = video.videoHeight / S.H, mg = 6;
    const x = Math.max(0, (caixa.x0 - mg) * sx), y = Math.max(0, (caixa.y0 - mg) * sy);
    const w = Math.min(video.videoWidth - x, (caixa.x1 - caixa.x0 + 2 * mg) * sx), h = Math.min(video.videoHeight - y, (caixa.y1 - caixa.y0 + 2 * mg) * sy);
    const k = Math.min(1, max / Math.max(w, h)), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    c.getContext('2d').drawImage(video, x, y, w, h, 0, 0, c.width, c.height);
    return c;
  }

  async function contar(t, obs) {
    // modo calibração: a peça não entra na contagem
    if (S.modoCal) {
      const mc = S.modoCal; S.modoCal = null;
      if (mc.tipo === 'escala') {
        const b = Cat.bases.get(mc.base);
        S.escala = obs.Hpx / b.dim.alt; await salvarCalibracao();
        t.rotulo = 'escala ✔'; toast(`Escala calibrada: ${S.escala.toFixed(2)} px/cm`);
      } else {
        await CoresEst.calibrar(mc.cor, obs.cor); renderPaleta();
        t.rotulo = 'cor ✔'; toast('Cor ' + Cat.nomeCor(mc.cor) + ' calibrada');
      }
      renderCal(); return;
    }
    const r = identificar(obs), top = r.top;
    const sku = top ? top.sku : 'NAO_IDENTIFICADO';
    const conf = top ? top.pModelo * top.pCor : 0;
    const revisar = !top || conf * 100 < S.cfg.confMin || obs.toca || !S.escala || top.distCor > 20;   // distCor > 20: cor longe de todas as cores possíveis
    const med = S.escala ? `A${(obs.Hpx / S.escala).toFixed(1)} L${(obs.Wmax / S.escala).toFixed(1)} B${(obs.Wbase / S.escala).toFixed(1)} cm` : 'sem escala';
    t.rotulo = sku;
    S.total++; S.contagem[sku] = (S.contagem[sku] || 0) + 1;
    const mini = recorte(t.melhorCaixa || obs.caixa, 160).toDataURL('image/jpeg', 0.6);
    S.ultimas.unshift({ obs, sku, base: top ? top.base : '', cor: top ? top.cor : '', conf, revisar, med, mini, hora: new Date(), hex: obs.cor.hex });
    S.ultimas = S.ultimas.slice(0, 12);
    DB.gravar('kv', { contagem: S.contagem, total: S.total }, 'est_contagem');
    render();
    if (S.cfg.registrar) {
      const comFoto = revisar || S.cfg.sempreFoto;
      const rec = {
        id: uuid(), ts: new Date().toISOString(), operador: cfg.operador || 'esteira', origem: 'esteira',
        sku, base: top ? top.base : '', cor: top ? top.cor : '', cor_nome: top ? Cat.nomeCor(top.cor) : '',
        produto: top ? Cat.rotulo(top.base) : '', quantidade: 1, encomenda: top ? !top.emLinha : false,
        sugerido: sku, confianca: Math.round(conf * 1000) / 1000, corrigido: false, revisar,
        medidas: med, cor_medida: obs.cor.hex,
        foto: comFoto ? recorte(t.melhorCaixa || obs.caixa, FOTO_MAX).toDataURL('image/jpeg', 0.75).split(',')[1] : '',
        dispositivo: 'esteira ' + (navigator.platform || ''), status: 'pendente'
      };
      await DB.gravar('fila', rec);
      if (Date.now() - S.ultimoEnvio > 10000) { S.ultimoEnvio = Date.now(); Fila.enviar(); } else atualizarFilaUI();
    }
  }

  /* ---------- desenho ---------- */
  function desenhar() {
    const c = S.tctx, k = S.tela.width / S.W;
    c.drawImage(video, 0, 0, S.tela.width, S.tela.height);
    if (S.cfg.mascara && S.mask) {
      const im = S.pctx.createImageData(S.W, S.H);
      for (let p = 0; p < S.mask.length; p++) if (S.mask[p]) { im.data[p * 4] = 255; im.data[p * 4 + 3] = 110; }
      S.pctx.putImageData(im, 0, 0); c.imageSmoothingEnabled = false; c.drawImage(S.proc, 0, 0, S.tela.width, S.tela.height); c.imageSmoothingEnabled = true;
    }
    const lx = S.tela.width * S.cfg.linha / 100;
    c.strokeStyle = '#ffd54f'; c.lineWidth = 3; c.setLineDash([10, 8]); c.beginPath(); c.moveTo(lx, 0); c.lineTo(lx, S.tela.height); c.stroke(); c.setLineDash([]);
    c.font = 'bold 16px system-ui'; c.textBaseline = 'bottom';
    for (const t of S.tracks) {
      if (!t.visto || !t.comp) continue; const b = t.comp;
      c.strokeStyle = t.contado ? '#4caf50' : '#ffffff'; c.lineWidth = 3;
      c.strokeRect(b.x0 * k, b.y0 * k, (b.x1 - b.x0 + 1) * k, (b.y1 - b.y0 + 1) * k);
      const txt = t.rotulo || ('#' + t.id), tw = c.measureText(txt).width + 10, ty = Math.max(20, b.y0 * k);
      c.fillStyle = 'rgba(0,0,0,.65)'; c.fillRect(b.x0 * k, ty - 20, tw, 20); c.fillStyle = '#fff'; c.fillText(txt, b.x0 * k + 5, ty - 2);
    }
    if (S.modoCal) { c.fillStyle = 'rgba(31,92,74,.9)'; c.fillRect(0, 0, S.tela.width, 26); c.fillStyle = '#fff'; c.fillText(S.modoCal.tipo === 'escala' ? 'Calibrando ESCALA: passe a peça ' + S.modoCal.base : 'Calibrando COR: passe uma peça ' + Cat.nomeCor(S.modoCal.cor), 8, 22); }
  }

  function loop(ts) {
    if (!S.rodando) return;
    S.raf = requestAnimationFrame(loop);
    if (!ts || ts - S.ultimoProc < 80) return;            // ~12 quadros/s
    S.ultimoProc = ts;
    if (!Cam.pronta() || !prepararTamanho()) return;
    if (!S.fundo) { S.tctx.drawImage(video, 0, 0, S.tela.width, S.tela.height); return; }
    try {
      const { d, comps, ganhos } = processar();
      rastrear(comps, d, ganhos);
      desenhar();
    } catch (e) { console.error(e); }
    S.nQuadros++;
    if (ts - S.tFps > 1000) { S.fps = S.nQuadros * 1000 / (ts - S.tFps); S.nQuadros = 0; S.tFps = ts; status(); }
  }

  /* ---------- controle ---------- */
  async function iniciar() {
    if (!Cam.stream) await Cam.ligar();
    if (!S.fundo) { toast('Calibre o fundo primeiro (esteira vazia)'); }
    S.rodando = true; S.tracks = []; $('#estIniciar').textContent = '⏸ Parar';
    try { if ('wakeLock' in navigator) S.wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
    loop(); status();
  }
  function parar() {
    S.rodando = false; cancelAnimationFrame(S.raf); $('#estIniciar').textContent = '▶ Iniciar';
    try { S.wakeLock && S.wakeLock.release(); } catch (_) {} S.wakeLock = null;
    status();
  }

  function status() {
    const partes = [
      S.rodando ? `rodando · ${S.fps.toFixed(0)} q/s` : 'parado',
      S.fundo ? 'fundo ok' : 'SEM FUNDO',
      S.escala ? `escala ${S.escala.toFixed(2)} px/cm` : 'SEM ESCALA (mede só proporção)',
      `${S.perfis.size} silhuetas`,
      `${S.tracks.filter(t => t.visto).length} na imagem`
    ];
    $('#estStatus').textContent = partes.join(' · ');
  }

  function render() {
    $('#estTotal').textContent = S.total;
    const ks = Object.entries(S.contagem).sort((a, b) => b[1] - a[1]);
    $('#estContagem').innerHTML = ks.length ? ks.map(([sku, n]) => {
      const info = Cat.skus.get(sku);
      return `<div class="reg"><span><span class="sku">${esc(sku)}</span><br><small class="sub">${esc(info ? Cat.rotulo(info.base) + ' · ' + Cat.nomeCor(info.cor_codigo) : (sku === 'NAO_IDENTIFICADO' ? 'não identificado' : ''))}</small></span><b style="font-size:20px">${n}</b></div>`;
    }).join('') : '<p class="vazio">Nenhuma peça contada.</p>';
    $('#estUltimas').innerHTML = S.ultimas.length ? S.ultimas.map(u => `
      <div class="peca"><img src="${u.mini}" alt="">
        <div style="flex:1"><span class="sku">${esc(u.sku)}</span>${u.revisar ? '<span class="tag rev">revisar</span>' : ''}<br>
        <small class="sub">${esc(u.med)} · <span class="sw" style="background:${u.hex};width:12px;height:12px;margin:0 2px"></span>${esc(u.cor ? Cat.nomeCor(u.cor) : '')} · confiança ${pct(u.conf)} · ${u.hora.toLocaleTimeString('pt-BR')}</small></div></div>`).join('')
      : '<p class="vazio">—</p>';
  }

  function renderCal() {
    $('#estEscSel').innerHTML = S.escBase ? `<b>${esc(S.escBase)}</b> — ${esc(Cat.rotulo(S.escBase))}` : 'Nenhum modelo escolhido';
    $('#estCalInfo').textContent = (S.escala ? `Escala atual: ${S.escala.toFixed(2)} px/cm.` : 'Escala ainda não calibrada.') + (S.modoCal ? ' Aguardando a próxima peça…' : '');
  }
  function renderPaleta() {
    const sel = $('#estCalCor'), v = sel.value;
    sel.innerHTML = Object.keys(CoresEst.refs).map(c => `<option value="${c}">${esc(Cat.nomeCor(c))} (${c})</option>`).join('');
    if (v) sel.value = v;
    $('#estPaleta').innerHTML = Object.entries(CoresEst.refs).map(([c, r]) =>
      `<div><span class="sw" style="background:${r.hex}"></span><span>${esc(Cat.nomeCor(c))}<br><small class="sub">${r.n ? 'calibrado (' + r.n + ')' : 'catálogo'}</small></span></div>`).join('');
  }

  function ajustesUI() {
    const liga = (id, chave, fmt) => {
      const el = $('#' + id), v = $('#' + id + 'V');
      if (el.type === 'checkbox') { el.checked = !!S.cfg[chave]; el.addEventListener('change', () => { S.cfg[chave] = el.checked; salvarCfg(); }); }
      else { el.value = S.cfg[chave]; if (v) v.textContent = fmt(S.cfg[chave]); el.addEventListener('input', () => { S.cfg[chave] = Number(el.value); if (v) v.textContent = fmt(S.cfg[chave]); salvarCfg(); }); }
    };
    liga('estLimiar', 'limiar', v => v); liga('estMinArea', 'minArea', v => v + '%'); liga('estLinha', 'linha', v => v + '%');
    liga('estConfMin', 'confMin', v => v + '%'); liga('estRegistrar', 'registrar'); liga('estSempreFoto', 'sempreFoto');
    liga('estSombra', 'sombra'); liga('estMascara', 'mascara');
  }

  /* ---------- foto avulsa (aba Identificar, celular na mão) ----------
     Sem foto do fundo vazio: o fundo é estimado pelas bordas da foto (até 3 cores),
     a peça é a região diferente disso que está no centro. Sem escala: compara
     contorno e proporção (altura/largura) com o catálogo. */
  function analisarFoto(foto) {
    const W = 160, H = Math.max(40, Math.round(foto.height * W / foto.width)), N = W * H;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(foto, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    // amostras da borda (6%)
    const bx = Math.max(2, Math.round(W * 0.06)), by = Math.max(2, Math.round(H * 0.06)), borda = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (x >= bx && x < W - bx && y >= by && y < H - by) continue;
      if ((x + y) % 2) continue; const i = (y * W + x) * 4; borda.push([d[i], d[i + 1], d[i + 2]]);
    }
    // k-means com 3 cores
    let cent = [borda[0], borda[Math.floor(borda.length / 2)], borda[borda.length - 1]].map(v => v.slice());
    const perto = v => { let bi = 0, bd = Infinity; cent.forEach((cc, k) => { const dd = (v[0] - cc[0]) ** 2 + (v[1] - cc[1]) ** 2 + (v[2] - cc[2]) ** 2; if (dd < bd) { bd = dd; bi = k; } }); return [bi, Math.sqrt(bd)]; };
    for (let it = 0; it < 8; it++) {
      const soma = cent.map(() => [0, 0, 0, 0]);
      for (const v of borda) { const [k] = perto(v); soma[k][0] += v[0]; soma[k][1] += v[1]; soma[k][2] += v[2]; soma[k][3]++; }
      cent = cent.map((cc, k) => soma[k][3] ? [soma[k][0] / soma[k][3], soma[k][1] / soma[k][3], soma[k][2] / soma[k][3]] : cc);
    }
    // só vale como fundo a cor que domina a borda (a peça pode encostar na borda, mas ocupa pouco dela)
    const qtd = cent.map(() => 0); for (const v of borda) qtd[perto(v)[0]]++;
    cent = cent.filter((_, k) => qtd[k] >= borda.length * 0.18);
    if (!cent.length) return null;
    const dists = borda.map(v => perto(v)[1]).filter(x => x < 60).sort((a, b) => a - b);
    const lim = Math.max(28, (dists[Math.floor(dists.length * 0.9)] || 20) * 1.6);
    // máscara
    const m = new Uint8Array(N), a = new Uint8Array(N), tmp = new Uint8Array(N);
    for (let p = 0; p < N; p++) { const i = p * 4; m[p] = perto([d[i], d[i + 1], d[i + 2]])[1] > lim ? 1 : 0; }
    morf(m, a, W, H, 2, true, tmp); morf(a, m, W, H, 2, false, tmp);
    morf(m, a, W, H, 1, false, tmp); morf(a, m, W, H, 1, true, tmp);
    // componentes: fica com a maior que encosta no centro
    const lab = new Int32Array(N), pilha = new Int32Array(N); let id = 0, melhor = null;
    for (let p0 = 0; p0 < N; p0++) {
      if (!m[p0] || lab[p0]) continue; id++;
      let topo = 0, area = 0, x0 = W, x1 = 0, y0 = H, y1 = 0, centro = 0; pilha[topo++] = p0; lab[p0] = id;
      while (topo) {
        const p = pilha[--topo], x = p % W, y = (p / W) | 0; area++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (Math.abs(x - W / 2) < W * 0.15 && Math.abs(y - H / 2) < H * 0.15) centro++;
        if (x > 0 && m[p - 1] && !lab[p - 1]) { lab[p - 1] = id; pilha[topo++] = p - 1; }
        if (x < W - 1 && m[p + 1] && !lab[p + 1]) { lab[p + 1] = id; pilha[topo++] = p + 1; }
        if (y > 0 && m[p - W] && !lab[p - W]) { lab[p - W] = id; pilha[topo++] = p - W; }
        if (y < H - 1 && m[p + W] && !lab[p + W]) { lab[p + W] = id; pilha[topo++] = p + W; }
      }
      if (area > N * 0.03 && centro > 0 && (!melhor || area > melhor.area)) melhor = { id, area, x0, x1, y0, y1 };
    }
    if (!melhor) return null;
    // preenche buracos da peça (ex.: boca aberta, reflexos)
    for (let y = melhor.y0; y <= melhor.y1; y++) {
      let l = -1, r = -1;
      for (let x = melhor.x0; x <= melhor.x1; x++) if (lab[y * W + x] === melhor.id) { if (l < 0) l = x; r = x; }
      if (l >= 0) for (let x = l; x <= r; x++) lab[y * W + x] = melhor.id;
    }
    const obs = observarEm(lab, W, H, melhor, d, [1, 1, 1]);
    // imagem de conferência: peça destacada
    const ov = ctx.getImageData(0, 0, W, H);
    for (let p = 0; p < N; p++) if (lab[p] !== melhor.id) { ov.data[p * 4] *= 0.35; ov.data[p * 4 + 1] *= 0.35; ov.data[p * 4 + 2] *= 0.35; }
    ctx.putImageData(ov, 0, 0);
    return { obs, modelos: classificar(obs, false), conferencia: c, toca: obs.toca };
  }

  async function carregarSilReais() {
    const lista = (await DB.ler('kv', 'silhuetas_mao')) || [];
    S.silReais = new Map();
    for (const r of lista) { if (!S.silReais.has(r.base)) S.silReais.set(r.base, []); S.silReais.get(r.base).push({ p: Float32Array.from(r.p), asp: r.asp }); }
  }
  async function adicionarSilhueta(base, obs) {
    if (!S.silReais.has(base)) S.silReais.set(base, []);
    const arr = S.silReais.get(base); arr.push({ p: Float32Array.from(obs.perfil), asp: obs.Hpx / obs.Wmax });
    if (arr.length > 30) arr.shift();
    const lista = []; for (const [b, rs] of S.silReais) for (const r of rs) lista.push({ base: b, p: Array.from(r.p), asp: r.asp });
    await DB.gravar('kv', lista, 'silhuetas_mao');
  }
  async function apagarSilhuetas(base) {
    if (base) S.silReais.delete(base); else S.silReais = new Map();
    const lista = []; for (const [b, rs] of S.silReais) for (const r of rs) lista.push({ base: b, p: Array.from(r.p), asp: r.asp });
    await DB.gravar('kv', lista, 'silhuetas_mao');
  }

  async function init() {
    S.tela = $('#estTela'); S.tctx = S.tela.getContext('2d');
    for (let i = 0; i < 100 && !DB.db; i++) await sleep(50);   // espera o banco local abrir
    lerCfg(); ajustesUI();
    await lerCalibracao(); await CoresEst.carregar();
    const cont = await DB.ler('kv', 'est_contagem'); if (cont) { S.contagem = cont.contagem || {}; S.total = cont.total || 0; }
    const pick = criarPicker($('#estEscBusca'), $('#estEscLista'), b => { S.escBase = b; renderCal(); });
    $('#estIniciar').addEventListener('click', () => S.rodando ? parar() : iniciar());
    $('#estFundo').addEventListener('click', calibrarFundo);
    $('#estTravar').addEventListener('click', () => travarCamera(false));
    $('#estZerar').addEventListener('click', async () => { if (!confirm('Zerar a contagem? (os registros já enviados continuam na planilha)')) return; S.contagem = {}; S.total = 0; S.ultimas = []; await DB.gravar('kv', { contagem: {}, total: 0 }, 'est_contagem'); render(); });
    $('#estEscala').addEventListener('click', () => {
      if (!S.escBase) { toast('Escolha o modelo da peça de referência'); return; }
      const b = Cat.bases.get(S.escBase); if (!b || !b.dim || !b.dim.alt) { toast('Esse modelo não tem altura no catálogo'); return; }
      S.modoCal = { tipo: 'escala', base: S.escBase }; renderCal(); if (!S.rodando) iniciar();
    });
    $('#estCor').addEventListener('click', () => { S.modoCal = { tipo: 'cor', cor: $('#estCalCor').value }; renderCal(); if (!S.rodando) iniciar(); });
    document.addEventListener('visibilitychange', async () => { if (!document.hidden && S.rodando && 'wakeLock' in navigator) { try { S.wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {} } });
    S.pick = pick;
    render(); renderCal(); renderPaleta(); status();
    carregarPerfis(); carregarSilReais();
  }

  return {
    S, init, classificar, analisarFoto, carregarPerfis, adicionarSilhueta, apagarSilhuetas,
    nSil(base) { return (S.silReais.get(base) || []).length; },
    aoTrocarAba(aba) {
      if (aba === 'est') { S.pick && S.pick.render(); renderPaleta(); renderCal(); carregarPerfis(); status(); }
      else if (S.rodando) parar();
    }
  };
})();
window.Esteira = Esteira;
Esteira.init();
