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
    LIST_URL: 'https://u.onelap.cn/analysis/list',
    UA: 'Onelap/3.10.0 (iPhone; iOS 15.0)',
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

  // 顽鹿活动列表
  function onelapList(token) {
    var url = CFG.LIST_URL + '?token=' + encodeURIComponent(token) +
      '&limit=100&type=all&page=1';
    return request(url, {
      headers: { 'User-Agent': CFG.UA, 'Accept': 'application/json' }
    }).then(function (r) { return r.json(); }).then(function (j) {
      return (j && (j.data || j.list || j.records)) || [];
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

  // 下载 FIT：先直连，失败再走备用代理
  function fetchFit(rawUrl) {
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
    'btnCopyDomain', 'resetSection'].forEach(function (id) { els[id] = $(id); });

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

    return onelapLogin(acc, pwd)
      .then(function (r) {
        onelapToken = r.token;
        if (r.user) { S.setJSON(K.user, r.user); state.user = r.user; }
        progress(12, '已登录顽鹿，正在读取骑行记录…');
        log('顽鹿登录成功：' + (r.user && r.user.nickname));
        return onelapList(onelapToken);
      })
      .then(function (list) {
        progress(28, '正在筛选最近 ' + sinceDays + ' 天的记录…');
        var acts = list.filter(function (a) {
          var t = a.startRidingTime || (a.start_time ? new Date(a.start_time).getTime() : 0);
          return t > since;
        });
        total = acts.length;
        log('顽鹿共 ' + list.length + ' 条，范围内 ' + total + ' 条');
        if (!total) throw { soft: true, msg: '最近 ' + sinceDays + ' 天没有顽鹿记录' };
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
          var startMs = a.startRidingTime || (a.start_time ? new Date(a.start_time).getTime() : 0);
          var startSec = Math.floor(startMs / 1000);
          a.__startSec = startSec;
          a.__id = String(a.id || a.activityId || startSec);
          if (doneMap[a.__id]) { skipped++; return; }
          if (times.some(function (t) { return Math.abs(t - startSec) < 180; })) { skipped++; return; }
          todo.push(a);
        });
        pending = Math.max(0, todo.length - maxN);
        var batch = todo.slice(0, maxN);
        log('待上传 ' + todo.length + ' 条，本次处理 ' + batch.length + ' 条');

        var i = 0;
        function next() {
          if (i >= batch.length) return Promise.resolve();
          var a = batch[i];
          var pct = 55 + Math.round((i / batch.length) * 44);
          progress(pct, '正在上传第 ' + (i + 1) + '/' + batch.length + ' 条…');
          var fitUrl = a.durl || a.fit_url || a.fileKey || '';
          if (!fitUrl || !/^https?:/i.test(fitUrl)) {
            log('× 无 FIT 链接，跳过 #' + a.__id, 'err');
            failed++; i++; return next();
          }
          return fetchFit(fitUrl)
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
          setStatus('同步失败：' + m);
          if (/refresh_token|授权失效|invalid_grant/i.test(m)) {
            log('提示：Strava 授权已失效，请重新连接 Strava', 'err');
          }
        }
        els.rider.className = 'rider-emoji';
        els.btnCloseOverlay.classList.remove('hidden');
      })
      .then(function () { busy = false; els.btnSync.disabled = false; });
  }

  /* ---------------- 事件绑定 ---------------- */

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
