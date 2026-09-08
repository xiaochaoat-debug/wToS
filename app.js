/* 数据搬运工 · 顽鹿(Onelap) → Strava
 * 纯前端实现：所有凭证保存在浏览器 localStorage，不经过任何第三方服务器。
 */
(function () {
  'use strict';

  var CFG = {
    CLIENT_ID: '218031',
    CLIENT_SECRET: '089c98d283a30377272c3ea13d2691087b00dd1a',
    SCOPE: 'activity:write,activity:read_all',
    LOGIN_URL: 'https://www.onelap.cn/api/login',
    UA: 'Onelap/3.10.0 (iPhone; iOS 15.0)',
    UA2: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    // 顽鹿新版 OTM 接口（旧版 /analysis/list 已废弃，返回 404）
    U_BASE: 'https://u.onelap.cn',
    OTM_LIST: 'https://u.onelap.cn/api/otm/ride_record/list',
    OTM_DETAIL: 'https://u.onelap.cn/api/otm/ride_record/analysis/{id}',
    OTM_FIT: 'https://u.onelap.cn/api/otm/ride_record/analysis/fit_content/{key}',
    SIGN_KEY: 'fe9f8382418fcdeb136461cac6acae7b',
    ST_TOKEN: 'https://www.strava.com/oauth/token',
    ST_API: 'https://www.strava.com/api/v3'
  };

  var K = {
    acc: 'w2s_acc', pwd: 'w2s_pwd', refresh: 'w2s_refresh', user: 'w2s_user',
    days: 'w2s_days', max: 'w2s_max', last: 'w2s_last', done: 'w2s_done',
    mode: 'w2s_mode', proxy: 'w2s_proxy'
  };

  var S = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    getJSON: function (k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } },
    setJSON: function (k, v) { S.set(k, JSON.stringify(v)); },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  var $ = function (id) { return document.getElementById(id); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var busy = false;

  /* ---------------- 网络 ---------------- */

  function request(url, opts) {
    opts = opts || {};
    return fetch(url, opts).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error('HTTP ' + res.status + ' ' + String(t).slice(0, 200));
        }, function () { throw new Error('HTTP ' + res.status); });
      }
      return res;
    });
  }

  // 顽鹿登录：密码 MD5，返回 { token, user }
  function onelapLogin(acc, pwd) {
    var body = 'account=' + encodeURIComponent(acc) + '&password=' + window.md5(pwd);
    return request(CFG.LOGIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body
    }).then(function (r) { return r.json(); }).then(function (j) {
      var item = (j && j.data && j.data[0]) || null;
      if (!item || !item.token) {
        throw new Error((j && (j.error || j.msg)) || '顽鹿登录失败，请检查账号密码');
      }
      var info = item.userinfo || {};
      return { token: item.token, user: { nickname: info.nickname || '骑友', avatar: info.avatar || '' } };
    });
  }

  /* ---- 顽鹿新版 OTM 接口 ---- */

  function randStr(n) {
    var s = 'abcdefghijklmnopqrstuvwxyz0123456789', out = '';
    for (var i = 0; i < n; i++) out += s.charAt(Math.floor(Math.random() * s.length));
    return out;
  }

  // 签名：参数按 key 升序拼 k=v，末尾加 &key=xxx，取 md5
  function signFor(params) {
    var nonce = randStr(16);
    var ts = String(Math.floor(Date.now() / 1000));
    var all = {};
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v !== null && v !== undefined && v !== '') all[k] = v;
    });
    all.nonce = nonce;
    all.timestamp = ts;
    var parts = Object.keys(all).sort().map(function (k) { return k + '=' + all[k]; });
    var raw = parts.join('&') + '&key=' + CFG.SIGN_KEY;
    return { nonce: nonce, timestamp: ts, sign: window.md5(raw), raw: raw };
  }

  function otmHeaders(token) {
    return {
      'Content-Type': 'application/json',
      'Authorization': token,
      'User-Agent': CFG.UA2,
      'Referer': CFG.U_BASE + '/recordPage'
    };
  }

  // mode: body(签名放 body) / query(签名放 url) / header(签名放 header, 可能被 CORS 拦) / none
  function otmList(token, mode, page) {
    page = page || 1;
    var payload = { page: page, limit: 50 };
    var sg = signFor(payload);
    var url = CFG.OTM_LIST;
    var body = { page: page, limit: 50 };
    var hdrs = otmHeaders(token);

    if (mode === 'body') {
      body.nonce = sg.nonce; body.timestamp = sg.timestamp; body.sign = sg.sign;
    } else if (mode === 'query') {
      url += '?nonce=' + sg.nonce + '&timestamp=' + sg.timestamp + '&sign=' + sg.sign;
    } else if (mode === 'header') {
      hdrs.nonce = sg.nonce; hdrs.timestamp = sg.timestamp; hdrs.sign = sg.sign;
    }
    return request(url, {
      method: 'POST', headers: hdrs, body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  function oldList(token, page) {
    page = page || 1;
    var url = CFG.U_BASE + '/analysis/list?token=' + encodeURIComponent(token) +
      '&limit=50&type=all&page=' + page;
    return request(url, {
      headers: { 'User-Agent': CFG.UA, 'Accept': 'application/json' }
    }).then(function (r) { return r.json(); });
  }

  function pickList(j) {
    if (!j) return null;
    if (j.data && Array.isArray(j.data.list)) return j.data.list;
    if (Array.isArray(j.data)) return j.data;
    if (Array.isArray(j.list)) return j.list;
    if (Array.isArray(j.records)) return j.records;
    return null;
  }

  // 依次尝试多种取列表方式，命中后自动翻页取全量；返回 { list, via, report }
  function onelapList(token) {
    var tries = [
      { name: '新版OTM·签名在body', mode: 'body', old: false },
      { name: '新版OTM·签名在query', mode: 'query', old: false },
      { name: '新版OTM·无签名', mode: 'none', old: false },
      { name: '旧版analysis/list', mode: 'old', old: true }
    ];
    var report = [];
    var i = 0;

    function call(t, page) {
      return t.old ? oldList(token, page) : otmList(token, t.mode, page);
    }

    function probe() {
      if (i >= tries.length) {
        var err = new Error('所有取列表方式都失败');
        err.report = report;
        throw err;
      }
      var t = tries[i++];
      return call(t, 1).then(function (j) {
        var list = pickList(j);
        report.push(t.name + ' → ' + JSON.stringify(j).slice(0, 200));
        if (list) return { t: t, j: j, list: list };
        return probe();
      }, function (e) {
        report.push(t.name + ' → 请求失败: ' + e.message);
        return probe();
      });
    }

    return probe().then(function (first) {
      var all = first.list.slice();
      var d = (first.j && first.j.data) || {};
      var total = parseInt(d.total || 0, 10) || 0;
      var pages = parseInt(d.pages || 0, 10) || 1;
      var maxPage = Math.min(pages, 20);
      var p = 1;

      function more() {
        if (p >= maxPage) return Promise.resolve();
        if (total && all.length >= total) return Promise.resolve();
        p++;
        return call(first.t, p).then(function (j) {
          var l = pickList(j);
          if (l && l.length) all = all.concat(l);
          else p = maxPage;
        }, function () { p = maxPage; }).then(more);
      }

      return more().then(function () {
        if (p > 1) report.push('翻页 ' + p + ' 页，共取到 ' + all.length + ' 条');
        return { list: all, via: first.t.name, report: report };
      });
    });
  }

  // Strava：用 refresh_token 换 access_token（Strava 会轮换 refresh_token，必须回存）
  function stravaRefresh(refreshToken) {
    return request(CFG.ST_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CFG.CLIENT_ID,
        client_secret: CFG.CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.access_token) throw new Error(j.message || 'Strava 授权失效，请重新授权');
      return j;
    });
  }

  // Strava：首次授权码换 token
  function stravaExchange(code) {
    return request(CFG.ST_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CFG.CLIENT_ID,
        client_secret: CFG.CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: String(code).trim()
      })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.refresh_token) throw new Error(j.message || '授权码无效或已过期');
      return j;
    });
  }

  function stravaActivities(accessToken) {
    return request(CFG.ST_API + '/athlete/activities?per_page=100', {
      headers: { Authorization: 'Bearer ' + accessToken }
    }).then(function (r) { return r.json(); }).then(function (list) {
      return (list || []).map(function (a) {
        return Math.floor(new Date(a.start_date).getTime() / 1000);
      });
    });
  }

  // 下载 FIT（直连，失败再走备用代理）
  function fetchFitUrl(rawUrl) {
    var url = String(rawUrl).replace(/^http:\/\//i, 'https://');
    return request(url, { mode: 'cors' })
      .then(function (r) { return r.arrayBuffer(); })
      .catch(function (err) {
        var proxies = [S.get(K.proxy, '')].concat([
          'https://api.allorigins.win/raw?url=',
          'https://api.codetabs.com/v1/proxy?quest='
        ]).filter(Boolean);
        var chain = proxies.reduce(function (p, prefix) {
          return p.catch(function () {
            return request(prefix + encodeURIComponent(url)).then(function (r) { return r.arrayBuffer(); });
          });
        }, Promise.reject(err));
        return chain.catch(function () { throw new Error('FIT 下载失败：' + err.message); });
      });
  }

  function b64(s) { return btoa(unescape(encodeURIComponent(String(s)))); }

  var FIT_KEYS = ['fitUrl', 'fit_url', 'fit', 'fitKey', 'fitkey', 'fileKey', 'file_key', 'durl'];

  function fitCandidate(obj) {
    if (!obj || typeof obj !== 'object') return '';
    for (var i = 0; i < FIT_KEYS.length; i++) {
      var v = obj[FIT_KEYS[i]];
      if (v && String(v).trim()) return String(v).trim();
    }
    return '';
  }

  function recId(rec) {
    return rec.id || rec.record_id || rec.ride_record_id || rec.rid || rec.activityId || '';
  }

  // 新版：先取详情拿 fitUrl，再走 fit_content/{base64}
  function fetchFitViaDetail(rec, token) {
    var id = recId(rec);
    if (!id) throw new Error('记录缺少 ID，无法取详情');
    return request(CFG.OTM_DETAIL.replace('{id}', encodeURIComponent(id)), {
      headers: { 'Authorization': token, 'User-Agent': CFG.UA2, 'Referer': CFG.U_BASE + '/recordPage' }
    }).then(function (r) { return r.json(); }).then(function (j) {
      var fk = fitCandidate(j && j.data) || fitCandidate(j) || fitCandidate(rec);
      if (!fk) throw new Error('详情里没找到 fitUrl');
      var cands = [fk];
      try { var d = decodeURIComponent(fk); if (d !== fk) cands.push(d); } catch (e) {}
      if (/^https?:/i.test(fk)) {
        try {
          var p = new URL(fk).pathname;
          if (p) { cands.push(p); cands.push(p.split('/').pop()); }
        } catch (e) {}
      } else if (fk.indexOf('/') >= 0) {
        cands.push(fk.split('/').pop());
      }
      var i = 0;
      function next() {
        if (i >= cands.length) throw new Error('fit_content 全部候选都失败');
        var c = cands[i++];
        return request(CFG.OTM_FIT.replace('{key}', encodeURIComponent(b64(c))), {
          headers: { 'Authorization': token, 'User-Agent': CFG.UA2 }
        }).then(function (r) { return r.arrayBuffer(); }, function () { return next(); });
      }
      return next();
    });
  }

  function fetchFitFor(rec, token) {
    var direct = fitCandidate(rec);
    if (direct && /^https?:/i.test(direct)) {
      return fetchFitUrl(direct).catch(function () { return fetchFitViaDetail(rec, token); });
    }
    return fetchFitViaDetail(rec, token);
  }

  function uploadFit(accessToken, buf, filename) {
    var fd = new FormData();
    fd.append('data_type', 'fit');
    fd.append('file', new Blob([buf], { type: 'application/octet-stream' }), filename);
    return request(CFG.ST_API + '/uploads', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken },
      body: fd
    }).then(function (r) { return r.json(); });
  }

  function pollUpload(accessToken, uploadId, times) {
    var i = 0;
    function step() {
      if (i++ >= times) return Promise.resolve({ timeout: true });
      return sleep(2000)
        .then(function () {
          return request(CFG.ST_API + '/uploads/' + uploadId, {
            headers: { Authorization: 'Bearer ' + accessToken }
          }).then(function (r) { return r.json(); });
        })
        .then(function (j) {
          if (j.activity_id) return { ok: true, id: j.activity_id };
          if (j.error) return { dup: /duplicate/i.test(j.error), err: j.error };
          if (j.status && /error/i.test(j.status)) return { err: j.status + ' ' + (j.error || '') };
          return step();
        });
    }
    return step();
  }

  /* ---------------- 本地去重记录 ---------------- */

  function loadDone() {
    var d = S.getJSON(K.done, {});
    var cutoff = Date.now() - 400 * 864e5;
    Object.keys(d).forEach(function (k) { if (!d[k] || d[k].at < cutoff) delete d[k]; });
    return d;
  }

  /* ---------------- UI ---------------- */

  var els = {};
  ['topDot', 'stOnelap', 'stStrava', 'onelapVal', 'stravaVal',
    'cardOnelap', 'cardStrava', 'onelapForm', 'onelapDone', 'onelapName',
    'stravaForm', 'stravaDone', 'inpAcc', 'inpPwd', 'inpCode', 'inpProxy',
    'btnLogin', 'btnStrava', 'btnBind', 'btnSync', 'btnReset',
    'syncArea', 'settingsPanel', 'settingsArrow', 'btnToggleSettings',
    'daysPicker', 'maxPicker', 'lastResult', 'lastResultTitle',
    'rSynced', 'rSkipped', 'rFailed', 'rTotal', 'statusText',
    'overlay', 'rider', 'progressFill', 'progressPct', 'syncStep', 'logBox',
    'btnCloseOverlay', 'btnClearDone', 'hintSelf', 'hintLocal', 'cbDomain',
    'btnCopyDomain', 'resetSection', 'btnDiag', 'btnCopyDiag'].forEach(function (id) { els[id] = $(id); });

  function setState(o) { Object.keys(o).forEach(function (k) { state[k] = o[k]; }); render(); }

  var state = {
    acc: S.get(K.acc, ''),
    pwd: S.get(K.pwd, ''),
    refresh: S.get(K.refresh, ''),
    user: S.getJSON(K.user, null),
    days: parseInt(S.get(K.days, '30'), 10) || 30,
    max: parseInt(S.get(K.max, '10'), 10) || 10,
    mode: S.get(K.mode, 'self'),
    last: S.getJSON(K.last, null),
    showSettings: false
  };

  function render() {
    var okOnelap = !!(state.acc && state.pwd);
    var okStrava = !!state.refresh;
    var ready = okOnelap && okStrava;

    els.topDot.className = 'top-dot' + (ready ? ' active' : '');

    els.stOnelap.className = 'status-item' + (okOnelap ? ' on' : '');
    els.stStrava.className = 'status-item' + (okStrava ? ' on' : '');
    els.onelapVal.textContent = okOnelap ? ((state.user && state.user.nickname) || '已连接') : '未连接';
    els.stravaVal.textContent = okStrava ? '已授权' : '未授权';

    els.cardOnelap.className = 'card' + (okOnelap ? ' done' : '');
    els.cardStrava.className = 'card' + (okStrava ? ' done' : '');

    els.onelapForm.classList.toggle('hidden', okOnelap);
    els.onelapDone.classList.toggle('hidden', !okOnelap);
    if (okOnelap) els.onelapName.textContent = (state.user && state.user.nickname) || '骑友';

    els.stravaForm.classList.toggle('hidden', okStrava);
    els.stravaDone.classList.toggle('hidden', !okStrava);

    els.syncArea.classList.toggle('hidden', !ready);
    els.resetSection.classList.toggle('hidden', !okOnelap && !okStrava);

    // 设置面板
    els.settingsPanel.classList.toggle('hidden', !state.showSettings);
    els.settingsArrow.textContent = state.showSettings ? '▲' : '▼';
    Array.prototype.forEach.call(els.daysPicker.children, function (b) {
      b.classList.toggle('on', parseInt(b.dataset.days, 10) === state.days);
    });
    Array.prototype.forEach.call(els.maxPicker.children, function (b) {
      b.classList.toggle('on', parseInt(b.dataset.max, 10) === state.max);
    });

    // 回调模式
    var radios = document.querySelectorAll('input[name="cbMode"]');
    Array.prototype.forEach.call(radios, function (r) { r.checked = r.value === state.mode; });
    els.hintSelf.classList.toggle('hidden', state.mode !== 'self');
    els.hintLocal.classList.toggle('hidden', state.mode !== 'localhost');

    // 上次结果
    if (state.last) {
      els.lastResult.classList.remove('hidden');
      els.lastResultTitle.textContent = '上次同步  ' + (state.last.time || '');
      els.rSynced.textContent = state.last.synced || 0;
      els.rSkipped.textContent = state.last.skipped || 0;
      els.rFailed.textContent = state.last.failed || 0;
      els.rTotal.textContent = state.last.total || 0;
      els.rFailed.className = 'result-num ' + ((state.last.failed > 0) ? 'red' : 'grey');
    } else {
      els.lastResult.classList.add('hidden');
    }
  }

  function setStatus(t) { els.statusText.textContent = t; }

  function progress(pct, text) {
    els.progressFill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    els.progressPct.textContent = Math.round(Math.max(0, Math.min(100, pct))) + '%';
    if (text) els.syncStep.textContent = text;
  }

  function log(msg, cls) {
    var d = document.createElement('div');
    if (cls) d.className = cls;
    d.textContent = msg;
    els.logBox.appendChild(d);
    els.logBox.scrollTop = els.logBox.scrollHeight;
  }

  function openOverlay() {
    els.logBox.innerHTML = '';
    els.btnCloseOverlay.classList.add('hidden');
    els.rider.className = 'rider-emoji rider-go';
    els.overlay.classList.remove('hidden');
    progress(0, '准备中…');
  }

  function closeOverlay() { els.overlay.classList.add('hidden'); }

  /* ---------------- 授权 ---------------- */

  function redirectUri() {
    if (state.mode === 'localhost') return 'http://localhost';
    return location.origin + location.pathname.replace(/index\.html$/, '');
  }

  function authUrl() {
    return 'https://www.strava.com/oauth/authorize?client_id=' + CFG.CLIENT_ID +
      '&redirect_uri=' + encodeURIComponent(redirectUri()) +
      '&response_type=code&approval_prompt=auto&scope=' + encodeURIComponent(CFG.SCOPE);
  }

  function bindWithCode(code) {
    if (!code) return;
    if (busy) return;
    busy = true;
    els.btnBind.disabled = true;
    setStatus('正在与 Strava 握手…');
    stravaExchange(code)
      .then(function (j) {
        S.set(K.refresh, j.refresh_token);
        state.refresh = j.refresh_token;
        els.inpCode.value = '';
        cleanUrl();
        render();
        setStatus('Strava 绑定成功');
      })
      .catch(function (e) {
        setStatus('绑定失败：' + e.message);
        alert('绑定失败：' + e.message);
      })
      .then(function () { busy = false; els.btnBind.disabled = false; });
  }

  function cleanUrl() {
    if (location.search) history.replaceState(null, '', location.pathname);
  }

  /* ---------------- 同步 ---------------- */

  function doSync() {
    if (busy) return;
    if (!state.acc || !state.pwd || !state.refresh) { setStatus('请先完成顽鹿登录与 Strava 授权'); return; }

    busy = true;
    els.btnSync.disabled = true;
    openOverlay();
    setStatus('同步进行中…');

    var acc = state.acc, pwd = state.pwd, refresh = state.refresh;
    var sinceDays = state.days, maxN = state.max;
    var since = Date.now() - sinceDays * 864e5;
    var doneMap = loadDone();

    var synced = 0, skipped = 0, failed = 0, total = 0, pending = 0;
    var onelapToken = '', accessToken = '';

    // 兼容新旧字段取开始时间（毫秒）
  function startTimeOf(a) {
    var v = a.activity_time || a.start_riding_time || a.startTime || a.startRidingTime ||
      a.start_time || a.created_at || a.date;
    if (!v) return 0;
    if (typeof v === 'number') return v > 1e11 ? v : v * 1000;
    var t = new Date(v).getTime();
    return isNaN(t) ? 0 : t;
  }

  return onelapLogin(acc, pwd)
      .then(function (r) {
        onelapToken = r.token;
        if (r.user) { S.setJSON(K.user, r.user); state.user = r.user; }
        progress(12, '已登录顽鹿，正在读取骑行记录…');
        log('顽鹿登录成功：' + (r.user && r.user.nickname));
        return onelapList(onelapToken);
      })
      .then(function (res) {
        if (res.report) res.report.forEach(function (l) { log('· ' + l); });
        log('取列表方式：' + res.via);
        var list = res.list;
        progress(28, '正在筛选最近 ' + sinceDays + ' 天的记录…');
        var acts = list.filter(function (a) { return startTimeOf(a) > since; });
        total = acts.length;
        log('顽鹿共取到 ' + list.length + ' 条，范围内 ' + total + ' 条');
        if (!total) {
          var newest = 0;
          list.forEach(function (a) { var t = startTimeOf(a); if (t > newest) newest = t; });
          var m = '最近 ' + sinceDays + ' 天没有顽鹿记录';
          if (newest) {
            m += '（最后一条是 ' + new Date(newest).toLocaleDateString('zh-CN') +
              '，把同步范围调大一点就有）';
          }
          throw { soft: true, msg: m };
        }
        return acts;
      })
      .then(function (acts) {
        progress(40, '正在连接 Strava…');
        return stravaRefresh(refresh).then(function (j) {
          accessToken = j.access_token;
          if (j.refresh_token && j.refresh_token !== refresh) {
            S.set(K.refresh, j.refresh_token);
            state.refresh = j.refresh_token;
            refresh = j.refresh_token;
          }
          log('Strava 授权有效');
          return stravaActivities(accessToken).then(function (times) {
            return { acts: acts, times: times };
          });
        });
      })
      .then(function (ctx) {
        progress(52, '正在比对重复记录…');
        var times = ctx.times;
        var todo = [];
        ctx.acts.forEach(function (a) {
          var startMs = startTimeOf(a);
          var startSec = Math.floor(startMs / 1000);
          a.__startSec = startSec;
          a.__id = String(recId(a) || a.activityId || startSec);
          if (doneMap[a.__id]) { skipped++; return; }
          if (times.some(function (t) { return Math.abs(t - startSec) < 180; })) { skipped++; return; }
          todo.push(a);
        });
        // 从新到旧传，先同步最近的骑行
        todo.sort(function (x, y) { return y.__startSec - x.__startSec; });
        pending = Math.max(0, todo.length - maxN);
        var batch = todo.slice(0, maxN);
        log('待上传 ' + todo.length + ' 条，本次处理 ' + batch.length + ' 条');

        var i = 0;
        function next() {
          if (i >= batch.length) return Promise.resolve();
          var a = batch[i];
          var pct = 55 + Math.round((i / batch.length) * 44);
          progress(pct, '正在上传第 ' + (i + 1) + '/' + batch.length + ' 条…');
          return fetchFitFor(a, onelapToken)
            .then(function (buf) {
              return uploadFit(accessToken, buf, 'onelap_' + a.__id + '_' + a.__startSec + '.fit');
            })
            .then(function (up) {
              if (!up || !up.id) throw new Error((up && up.message) || '上传接口未返回 id');
              return pollUpload(accessToken, up.id, 8);
            })
            .then(function (res) {
              if (res.ok) {
                synced++; doneMap[a.__id] = { at: Date.now() };
                log('✓ 已同步 #' + a.__id + ' → strava:' + res.id, 'ok');
              } else if (res.dup) {
                skipped++; doneMap[a.__id] = { at: Date.now() };
                log('– Strava 已存在，跳过 #' + a.__id);
              } else {
                failed++;
                log('× 失败 #' + a.__id + '：' + (res.err || '处理超时'), 'err');
              }
            })
            .catch(function (e) {
              failed++;
              log('× 异常 #' + a.__id + '：' + e.message, 'err');
            })
            .then(function () { i++; return next(); });
        }
        return next();
      })
      .then(function () {
        S.setJSON(K.done, doneMap);
        progress(100, '同步完成');
        els.rider.className = 'rider-emoji rider-win';

        var result = {
          synced: synced, skipped: skipped, failed: failed, total: total,
          time: new Date().toLocaleString('zh-CN', {
            month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
          })
        };
        S.setJSON(K.last, result);
        state.last = result;

        var msg = '同步完成：新增 ' + synced + ' 条，已有 ' + skipped + ' 条，失败 ' + failed + ' 条';
        if (pending > 0) msg += '（还剩 ' + pending + ' 条，再点一次继续）';
        log(msg, synced > 0 ? 'ok' : '');
        setStatus(msg);
        render();
        els.btnCloseOverlay.classList.remove('hidden');
      })
      .catch(function (e) {
        if (e && e.soft) {
          progress(100, e.msg);
          log(e.msg);
          setStatus(e.msg);
        } else {
          var m = (e && e.message) || String(e);
          progress(100, '同步中断');
          log('× ' + m, 'err');
          if (/Inactive/i.test(m)) {
            setStatus('Strava 应用未激活：需要有效的 Strava 订阅');
            log('说明：2026-07 起 Strava 要求 API 应用所属账号必须有付费订阅，', 'err');
            log('否则应用被标为 Inactive，所有接口都返回 403。', 'err');
            log('解决：用【拥有该应用的账号】买订阅 → https://www.strava.com/settings/api 重新激活', 'err');
          } else if (/refresh_token|授权失效|invalid_grant|unauthorized/i.test(m)) {
            setStatus('Strava 授权已失效，请重新连接 Strava');
            log('提示：Strava 授权已失效，请重新连接 Strava', 'err');
          } else {
            setStatus('同步失败：' + m);
          }
        }
        els.rider.className = 'rider-emoji';
        els.btnCloseOverlay.classList.remove('hidden');
      })
      .then(function () { busy = false; els.btnSync.disabled = false; });
  }

  /* ---------------- 事件绑定 ---------------- */

  /* ---------------- 接口诊断 ---------------- */

  var diagText = '';

  function runDiag() {
    if (busy) return;
    if (!state.acc || !state.pwd) { setStatus('请先完成顽鹿登录再做诊断'); return; }
    busy = true;
    els.btnDiag.disabled = true;
    diagText = '';
    openOverlay();
    els.btnCopyDiag.classList.add('hidden');
    progress(5, '诊断中…');

    var lines = [];
    return onelapLogin(state.acc, state.pwd)
      .then(function (r) {
        var token = r.token;
        lines.push('登录成功，token = ' + token);
        log('登录成功，token = ' + token.slice(0, 14) + '…', 'ok');

        var modes = [
          ['新版OTM·签名在body', function () { return otmList(token, 'body'); }],
          ['新版OTM·签名在query', function () { return otmList(token, 'query'); }],
          ['新版OTM·无签名', function () { return otmList(token, 'none'); }],
          ['新版OTM·签名在header', function () { return otmList(token, 'header'); }],
          ['旧版analysis/list', function () { return oldList(token); }]
        ];
        var i = 0;
        function next() {
          if (i >= modes.length) return Promise.resolve();
          var m = modes[i++];
          progress(Math.round(i / modes.length * 95) + 5, '诊断：' + m[0]);
          return m[1]().then(function (j) {
            var s = JSON.stringify(j);
            lines.push('【' + m[0] + '】' + s.slice(0, 800));
            log('【' + m[0] + '】' + s.slice(0, 260), (j && j.code && j.code !== 200) ? 'err' : 'ok');
          }, function (e) {
            lines.push('【' + m[0] + '】请求失败: ' + e.message);
            log('【' + m[0] + '】请求失败: ' + e.message, 'err');
          }).then(next);
        }
        return next();
      })
      .catch(function (e) {
        lines.push('登录失败: ' + e.message);
        log('× 登录失败：' + e.message, 'err');
      })
      .then(function () {
        diagText = lines.join('\n\n');
        progress(100, '诊断完成');
        els.btnCopyDiag.classList.remove('hidden');
        els.btnCloseOverlay.classList.remove('hidden');
        setStatus('诊断完成，点「复制诊断结果」把结果发我');
        busy = false;
        els.btnDiag.disabled = false;
      });
  }

  function init() {
    els.inpAcc.value = state.acc;
    els.inpPwd.value = state.pwd;
    els.inpProxy.value = S.get(K.proxy, '');
    els.cbDomain.textContent = location.hostname || 'xiaochaoat-debug.github.io';
    render();

    els.btnLogin.addEventListener('click', function () {
      var acc = els.inpAcc.value.trim(), pwd = els.inpPwd.value.trim();
      if (!acc || !pwd) { setStatus('请输入完整的顽鹿账号和密码'); return; }
      if (busy) return;
      busy = true;
      els.btnLogin.disabled = true;
      els.btnLogin.textContent = '验证中…';
      setStatus('正在验证顽鹿账号…');
      onelapLogin(acc, pwd)
        .then(function (r) {
          S.set(K.acc, acc); S.set(K.pwd, pwd); S.setJSON(K.user, r.user);
          setState({ acc: acc, pwd: pwd, user: r.user });
          setStatus('顽鹿验证成功');
        })
        .catch(function (e) { setStatus('验证失败：' + e.message); })
        .then(function () {
          busy = false;
          els.btnLogin.disabled = false;
          els.btnLogin.textContent = '身份验证';
        });
    });

    document.querySelectorAll('input[name="cbMode"]').forEach(function (r) {
      r.addEventListener('change', function () {
        if (!r.checked) return;
        S.set(K.mode, r.value);
        state.mode = r.value;
        render();
      });
    });

    els.btnCopyDomain.addEventListener('click', function () {
      var t = els.cbDomain.textContent;
      if (navigator.clipboard) navigator.clipboard.writeText(t);
      els.btnCopyDomain.textContent = '已复制';
      setTimeout(function () { els.btnCopyDomain.textContent = '复制'; }, 1500);
    });

    els.btnStrava.addEventListener('click', function () {
      setStatus('正在跳转 Strava 授权…');
      location.href = authUrl();
    });

    els.btnBind.addEventListener('click', function () { bindWithCode(extractCode(els.inpCode.value)); });

    els.inpCode.addEventListener('input', function () {
      var c = extractCode(els.inpCode.value);
      if (c && c.length > 10) bindWithCode(c);
    });

    els.btnToggleSettings.addEventListener('click', function () {
      state.showSettings = !state.showSettings;
      render();
    });

    els.daysPicker.addEventListener('click', function (e) {
      var b = e.target.closest('.day-opt');
      if (!b) return;
      S.set(K.days, b.dataset.days);
      state.days = parseInt(b.dataset.days, 10);
      render();
    });

    els.maxPicker.addEventListener('click', function (e) {
      var b = e.target.closest('.day-opt');
      if (!b) return;
      S.set(K.max, b.dataset.max);
      state.max = parseInt(b.dataset.max, 10);
      render();
    });

    els.inpProxy.addEventListener('change', function () { S.set(K.proxy, els.inpProxy.value.trim()); });

    els.btnClearDone.addEventListener('click', function () {
      S.del(K.done);
      setStatus('已清除本地去重记录，下次同步会重新检查');
    });

    els.btnSync.addEventListener('click', doSync);
    els.btnCloseOverlay.addEventListener('click', closeOverlay);

    els.btnDiag.addEventListener('click', runDiag);
    els.btnCopyDiag.addEventListener('click', function () {
      if (navigator.clipboard) navigator.clipboard.writeText(diagText);
      els.btnCopyDiag.textContent = '已复制';
      setTimeout(function () { els.btnCopyDiag.textContent = '复制诊断结果'; }, 1500);
    });

    els.btnReset.addEventListener('click', function () {
      if (!confirm('确定要清除本机保存的所有登录信息吗？')) return;
      Object.keys(K).forEach(function (k) { S.del(K[k]); });
      state = {
        acc: '', pwd: '', refresh: '', user: null,
        days: 30, max: 10, mode: 'self', last: null, showSettings: false
      };
      els.inpAcc.value = ''; els.inpPwd.value = ''; els.inpProxy.value = '';
      render();
      setStatus('已安全退出');
    });

    // 回调带上 ?code= 时自动完成绑定
    var code = new URLSearchParams(location.search).get('code');
    if (code) {
      els.inpCode.value = location.href;
      bindWithCode(code);
    }
  }

  function extractCode(v) {
    if (!v) return '';
    var s = String(v).trim();
    if (/^https?:/i.test(s) || s.indexOf('code=') >= 0) {
      var m = s.match(/[?&]code=([^&#]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    }
    return s;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
