// ============================================================================
//  admin.js - 관리자(교사) 화면(admin.html)의 동작
// ============================================================================
//  구성
//    1) 로그인 / 관리자 계정 만들기
//    2) 대시보드 : 투표 스위치, 현황 숫자, 제목·안내문, 교사 계정
//    3) 작품     : 이미지 올리기(+CSV 자동 채우기), 수정·숨김·삭제
//    4) 학생     : 목록, 검색, 기기 연결 해제, 프로필 삭제, CSV
//    5) 댓글     : 실제 이름과 함께 보기, 숨김/보이기/삭제
//    6) 결과     : 순위표 + CSV 3종
//
//  보안 메모
//    - 이 화면의 코드도 공개되어 있습니다. "관리자만 가능"은 화면이 아니라
//      DB의 보안 정책(is_admin 함수)이 지킵니다. 관리자가 아닌 계정으로 이 화면의
//      코드를 흉내 내어 요청해도 DB가 거절합니다.
//    - 학생이 쓴 글(이름·댓글 등)은 항상 textContent 로 넣어 악성 코드가 실행되지 않게 합니다.
// ============================================================================
(function () {
  'use strict';

  const cfg = window.APP_CONFIG;

  // 학생 화면과 로그인이 섞이지 않도록 저장 이름(storageKey)을 다르게 씁니다.
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { storageKey: 'vote-admin', persistSession: true, autoRefreshToken: true },
  });

  const PAGE = 1000; // Supabase 는 한 번에 최대 1000줄만 주므로 나누어 받습니다.

  // ----- 화면 상태 -----
  const state = {
    email: '',        // 로그인한 교사 이메일
    settings: null,
    entries: [],      // 등록된 작품
    pending: [],      // 올리기 전 대기 중인 이미지 [{ file, url, title, author, description }]
    csvRows: [],      // 불러온 작품 정보 [{ title, author, description, keyword }]
    students: [],
    comments: [],
  };

  // ==========================================================================
  //  도우미
  // ==========================================================================
  const $ = (id) => document.getElementById(id);

  // 요소를 만드는 작은 도우미 (app.js 와 같은 것)
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'value') el.value = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children) {
      if (c === null || c === undefined) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  let toastTimer;
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
  }

  // 오류를 한국어 문장으로
  function errorText(err) {
    const msg = (err && err.message) || '';
    // DB에 표·함수가 아직 없을 때
    if (/^(PGRST202|PGRST205|42P01|42883)$/.test((err && err.code) || '')) {
      return 'DB 설정이 아직 안 되어 있습니다. Supabase SQL Editor 에서 supabase/schema.sql 을 먼저 실행해 주세요.';
    }
    if (/Invalid login credentials/i.test(msg)) return '이메일 또는 비밀번호가 올바르지 않습니다.';
    if (/Email not confirmed/i.test(msg)) {
      return '아직 활성화되지 않은 계정입니다. 아래 "관리자 계정 만들기"에 같은 이메일과 가입 코드를 입력해 주세요.';
    }
    if (/Password should be/i.test(msg)) return '비밀번호는 6자 이상이어야 합니다.';
    if (/rate limit/i.test(msg)) return '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
    if (/Signups not allowed|signup is disabled/i.test(msg)) {
      return 'Supabase 에서 이메일 가입이 꺼져 있습니다. Authentication 설정을 확인해 주세요.';
    }
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return '인터넷 연결을 확인해 주세요.';
    if (/[가-힣]/.test(msg)) return msg; // DB 함수가 보낸 한글 안내
    return '문제가 생겼습니다. (' + (msg || '알 수 없는 오류') + ')';
  }

  function showError(el, err) {
    el.textContent = errorText(err);
    el.hidden = false;
  }

  function timeText(iso) {
    return iso ? new Date(iso).toLocaleString('ko-KR') : '';
  }

  function imageUrl(path) {
    return sb.storage.from(cfg.BUCKET).getPublicUrl(path).data.publicUrl;
  }

  // 1000줄이 넘는 목록을 끝까지 받아 옵니다. build 는 "조회 요청을 새로 만드는 함수"입니다.
  async function fetchAll(build) {
    const out = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await build().range(from, from + PAGE - 1);
      if (error) throw error;
      out.push(...data);
      if (data.length < PAGE) break;
    }
    return out;
  }

  // 표 그리기: headers = ['학교', ...], rows = [[칸, 칸, ...], ...] (칸은 글자 또는 요소)
  function renderTable(table, headers, rows, emptyText, rowClass) {
    table.replaceChildren(
      h('thead', {}, h('tr', {}, ...headers.map((t) => h('th', {}, t)))),
      h('tbody', {}, ...(rows.length
        ? rows.map((cells, i) => h('tr', { class: rowClass ? rowClass(i) : null },
            ...cells.map((c) => (c instanceof HTMLTableCellElement ? c : h('td', {}, c)))))
        : [h('tr', {}, h('td', { class: 'empty', colspan: headers.length }, emptyText))])),
    );
  }

  // ----- CSV 만들기 / 내려받기 -----
  // 엑셀이 한글을 올바로 읽도록 맨 앞에 UTF-8 BOM(﻿)을 붙입니다.
  function downloadCsv(filename, headers, rows) {
    const cell = (v) => {
      let s = v === null || v === undefined ? '' : String(v);
      // 학생이 쓴 글이 = + - @ 로 시작하면 엑셀이 수식으로 실행할 수 있어, 앞에 ' 를 붙여 막습니다.
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const text = [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // CSV 글자를 표(2차원 배열)로 읽기. 따옴표 안의 쉼표·줄바꿈도 처리합니다.
  function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    const rows = [];
    let row = [], cur = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
        } else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c !== '\r') cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter((r) => r.some((x) => x.trim() !== ''));
  }

  // CSV 파일 읽기: UTF-8 로 먼저 읽고, 깨지면 엑셀 기본 저장 형식(EUC-KR/CP949)으로 다시 읽습니다.
  async function readCsvFile(file) {
    const buf = await file.arrayBuffer();
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch (e) {
      return new TextDecoder('euc-kr').decode(buf);
    }
  }

  // ==========================================================================
  //  1) 로그인 / 관리자 계정 만들기
  // ==========================================================================

  function showView(name) {
    $('boot').hidden = true;
    $('loginView').hidden = name !== 'login';
    $('appView').hidden = name !== 'app';
  }

  // 로그인된 계정이 관리자인지 DB에 물어보고 화면을 정합니다.
  async function enter() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { showView('login'); return; }

    const { data: ok, error } = await sb.rpc('is_admin');
    if (error || !ok) {
      await sb.auth.signOut({ scope: 'local' });
      showView('login');
      showError($('loginError'), error || { message: '관리자 권한이 없는 계정입니다.' });
      return;
    }
    state.email = (session.user.email || '').toLowerCase();
    $('me').textContent = state.email;
    showView('app');
    openTab('dash');
  }

  async function login(email, password) {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await enter();
  }

  // 관리자 계정 만들기: 계정 생성 → 활성화 → 관리자 등록
  //   가입 코드는 DB 함수 register_admin 만 확인할 수 있습니다. (화면 코드에는 코드가 없습니다)
  async function createAdminAccount(email, password, code) {
    // (1) 코드부터 확인합니다. 코드가 틀리면 계정을 만들지 않고 여기서 끝납니다.
    let r = await sb.rpc('register_admin', { p_email: email, p_code: code });
    if (!r.error) return;                                  // 이미 있던 계정 → 관리자로 등록됨
    if (!/계정이 없습니다/.test(r.error.message)) throw r.error; // 코드 오류 등

    // (2) 계정을 만듭니다. 지금 로그인된 교사의 로그인 상태를 건드리지 않도록
    //     저장을 하지 않는 임시 연결을 따로 씁니다.
    const tmp = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { storageKey: 'vote-signup-tmp', persistSession: false, autoRefreshToken: false },
    });
    const s = await tmp.auth.signUp({ email, password });
    if (s.error) throw s.error;

    // (3) 계정을 활성화하고 관리자로 등록합니다.
    r = await sb.rpc('register_admin', { p_email: email, p_code: code });
    if (r.error) throw r.error;
  }

  $('loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('loginError').hidden = true;
    try {
      await login($('loginEmail').value.trim(), $('loginPw').value);
    } catch (err) {
      showError($('loginError'), err);
    }
  });

  $('signupForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const errBox = $('signupError');
    const btn = ev.target.querySelector('button[type="submit"]');
    errBox.hidden = true;
    btn.disabled = true;
    try {
      const email = $('signupEmail').value.trim();
      await createAdminAccount(email, $('signupPw').value, $('signupCode').value);
      await login(email, $('signupPw').value);
      ev.target.reset();
    } catch (err) {
      showError(errBox, err);
    } finally {
      btn.disabled = false;
    }
  });

  $('logoutBtn').addEventListener('click', async () => {
    await sb.auth.signOut({ scope: 'local' });
    showView('login');
  });

  // ==========================================================================
  //  탭 전환
  // ==========================================================================
  const loaders = {
    dash: loadDash, entries: loadEntries, students: loadStudents,
    comments: loadComments, results: loadResults,
  };

  function openTab(name) {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== 'tab-' + name; });
    // 탭을 열 때마다 최신 내용을 다시 불러옵니다.
    loaders[name]().catch((err) => { console.error(err); toast(errorText(err)); });
  }

  document.querySelectorAll('.tabs button').forEach((b) => {
    b.addEventListener('click', () => openTab(b.dataset.tab));
  });

  // ==========================================================================
  //  2) 대시보드
  // ==========================================================================

  // 표의 줄 수만 셉니다. (head: true = 내용은 받지 않고 개수만)
  async function countOf(table) {
    const { count, error } = await sb.from(table).select('*', { count: 'exact', head: true });
    if (error) throw error;
    return count;
  }

  function renderVote() {
    const open = state.settings.voting_open;
    $('voteToggle').checked = open;
    $('voteLabel').textContent = open ? '투표 진행 중' : '투표 마감(중지) 상태';
    $('voteHint').textContent = open
      ? '학생들이 하트와 댓글을 남길 수 있습니다.'
      : '학생들은 작품을 보기만 할 수 있습니다.';
  }

  async function loadDash() {
    const s = await sb.from('settings').select('*').eq('id', 1).single();
    if (s.error) throw s.error;
    state.settings = s.data;
    renderVote();
    $('setTitle').value = s.data.site_title;
    $('setNotice').value = s.data.site_notice;

    const [e, st, l, c] = await Promise.all(
      ['entries', 'students', 'likes', 'comments'].map(countOf));
    $('nEntries').textContent = e;
    $('nStudents').textContent = st;
    $('nLikes').textContent = l;
    $('nComments').textContent = c;

    await loadAdmins();
  }

  async function saveSettings(patch, doneText) {
    const { data, error } = await sb.from('settings')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', 1).select().single();
    if (error) throw error;
    state.settings = data;
    toast(doneText);
  }

  // 투표 시작/마감 스위치
  $('voteToggle').addEventListener('change', async (ev) => {
    const open = ev.target.checked;
    try {
      await saveSettings({ voting_open: open }, open ? '투표를 시작했습니다.' : '투표를 마감했습니다.');
    } catch (err) {
      toast(errorText(err));
    }
    renderVote(); // 실패했다면 스위치가 원래 상태로 돌아갑니다.
  });

  $('settingsForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await saveSettings({
        site_title: $('setTitle').value.trim(),
        site_notice: $('setNotice').value.trim(),
      }, '저장했습니다.');
    } catch (err) {
      toast(errorText(err));
    }
  });

  // ----- 교사 계정 -----
  async function loadAdmins() {
    const { data, error } = await sb.from('admins').select('email, created_at').order('created_at');
    if (error) throw error;
    $('adminList').replaceChildren(...data.map((a) => h('li', {},
      h('span', {}, a.email, a.email === state.email ? ' (나)' : ''),
      // 본인은 해제할 수 없습니다. (DB 함수에서도 다시 막습니다)
      a.email === state.email ? null
        : h('button', { type: 'button', class: 'btn danger', onclick: () => removeAdmin(a.email) }, '권한 해제'))));
  }

  async function removeAdmin(email) {
    if (!confirm(email + ' 의 관리자 권한을 해제할까요?')) return;
    const { error } = await sb.rpc('remove_admin', { p_email: email });
    if (error) { toast(errorText(error)); return; }
    toast('권한을 해제했습니다.');
    loadAdmins();
  }

  $('addAdminForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector('button');
    btn.disabled = true;
    try {
      await createAdminAccount($('addEmail').value.trim(), $('addPw').value, $('addCode').value);
      ev.target.reset();
      toast('교사 계정을 추가했습니다.');
      await loadAdmins();
    } catch (err) {
      toast(errorText(err));
    } finally {
      btn.disabled = false;
    }
  });

  // ==========================================================================
  //  3) 작품
  // ==========================================================================

  // ----- 올리기 전 대기 목록 -----
  function addFiles(fileList) {
    const files = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) { toast('이미지 파일만 올릴 수 있습니다.'); return; }
    for (const file of files) {
      const item = {
        file,
        url: URL.createObjectURL(file),              // 미리보기 주소
        title: file.name.replace(/\.[^.]+$/, ''),    // 기본 제목 = 확장자를 뺀 파일 이름
        author: '',
        description: '',
      };
      autoFill(item);
      state.pending.push(item);
    }
    renderPending();
  }

  // 파일 이름에 CSV 의 "파일명키워드"가 들어 있으면 제목·출품자·설명을 자동으로 채웁니다.
  // 여러 개가 맞으면 가장 긴 키워드를 고릅니다. (예: "토끼" 보다 "달토끼"가 우선)
  function autoFill(item) {
    const name = item.file.name.toLowerCase();
    let best = null;
    for (const row of state.csvRows) {
      const key = row.keyword.trim().toLowerCase();
      if (key && name.includes(key) && (!best || key.length > best.keyword.trim().length)) best = row;
    }
    if (best) applyRow(item, best);
    return Boolean(best);
  }

  function applyRow(item, row) {
    item.title = row.title;
    item.author = row.author;
    item.description = row.description;
  }

  function renderPending() {
    const box = $('pendingList');
    box.replaceChildren(...state.pending.map((item) => {
      const title = h('input', { type: 'text', placeholder: '제목', value: item.title, maxlength: 60,
        oninput: (e) => { item.title = e.target.value; } });
      const author = h('input', { type: 'text', placeholder: '출품자', value: item.author, maxlength: 40,
        oninput: (e) => { item.author = e.target.value; } });
      const desc = h('textarea', { class: 'full', rows: 2, placeholder: '작품 설명',
        oninput: (e) => { item.description = e.target.value; } });
      desc.value = item.description;

      // CSV 를 불러왔다면, 자동으로 안 맞은 작품을 직접 고를 수 있는 선택 상자를 보여 줍니다.
      let picker = null;
      if (state.csvRows.length) {
        picker = h('select', { class: 'full', 'aria-label': 'CSV 항목 선택',
          onchange: (e) => {
            const row = state.csvRows[Number(e.target.value)];
            if (row) { applyRow(item, row); renderPending(); }
          } },
          h('option', { value: '' }, 'CSV 항목에서 골라 채우기…'),
          ...state.csvRows.map((r, i) => h('option', { value: i }, r.title + ' - ' + r.author)));
      }

      return h('div', { class: 'item' },
        h('img', { src: item.url, alt: '' }),
        h('div', { class: 'fields two' },
          picker, title, author, desc,
          h('div', { class: 'actions full' },
            h('span', { class: 'file-name' }, item.file.name),
            h('button', { type: 'button', class: 'btn', onclick: () => {
              URL.revokeObjectURL(item.url);
              state.pending = state.pending.filter((x) => x !== item);
              renderPending();
            } }, '빼기'))));
    }));
    $('uploadBtn').hidden = state.pending.length === 0;
    $('uploadBtn').textContent = '모두 올리기 (' + state.pending.length + '개)';
  }

  // 큰 이미지는 올리기 전에 줄입니다. (긴 변 1600px, WebP)
  // 학생 휴대폰에서 갤러리가 빨리 뜨게 하기 위한 것이며, 투명 배경은 유지됩니다.
  async function shrinkImage(file) {
    if (file.type === 'image/gif') return file; // 움직이는 GIF 는 그대로
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file; // 이미 작으면 그대로
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((done) => canvas.toBlob(done, 'image/webp', 0.9));
      if (!blob || blob.size >= file.size) return file; // 줄여도 이득이 없으면 원본 사용
      return blob;
    } catch (e) {
      return file; // 줄이기에 실패하면 원본을 그대로 올립니다.
    }
  }

  const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

  async function uploadAll() {
    const btn = $('uploadBtn');
    btn.disabled = true;
    let done = 0;
    const failed = [];
    for (const item of state.pending.slice()) {
      btn.textContent = '올리는 중… (' + (done + failed.length + 1) + '/' + state.pending.length + ')';
      try {
        const blob = await shrinkImage(item.file);
        const ext = EXT[blob.type];
        if (!ext) throw new Error('PNG, JPG, WebP, GIF 이미지만 올릴 수 있습니다.');
        // 한글 파일 이름은 저장소에서 문제를 일으킬 수 있어, 겹치지 않는 영문 이름을 새로 만듭니다.
        const path = Date.now() + '-' + Math.random().toString(36).slice(2, 10) + '.' + ext;

        // (1) 이미지 파일을 Storage 에 올리고
        const up = await sb.storage.from(cfg.BUCKET).upload(path, blob, { contentType: blob.type });
        if (up.error) throw up.error;

        // (2) 작품 정보를 표에 저장합니다. 실패하면 방금 올린 파일을 지워 찌꺼기를 남기지 않습니다.
        const ins = await sb.from('entries').insert({
          title: item.title.trim(), author: item.author.trim(),
          description: item.description.trim(), image_path: path,
        });
        if (ins.error) {
          await sb.storage.from(cfg.BUCKET).remove([path]);
          throw ins.error;
        }
        URL.revokeObjectURL(item.url);
        state.pending = state.pending.filter((x) => x !== item);
        done++;
      } catch (err) {
        console.error(err);
        failed.push(item.file.name + ': ' + errorText(err));
      }
    }
    btn.disabled = false;
    renderPending();
    await loadEntries();
    toast(failed.length ? done + '개 올림, ' + failed.length + '개 실패 - ' + failed[0] : done + '개 작품을 올렸습니다.');
  }

  // ----- 등록된 작품 목록 -----
  async function loadEntries() {
    const { data, error } = await sb.from('entries').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    state.entries = data;
    $('entryCount').textContent = data.length + '개';
    const box = $('entryList');
    if (data.length === 0) {
      box.replaceChildren(h('p', { class: 'hint' }, '아직 등록된 작품이 없습니다.'));
      return;
    }
    box.replaceChildren(...data.map(entryItem));
  }

  function entryItem(e) {
    const title = h('input', { type: 'text', value: e.title, placeholder: '제목', maxlength: 60 });
    const author = h('input', { type: 'text', value: e.author, placeholder: '출품자', maxlength: 40 });
    const desc = h('textarea', { class: 'full', rows: 3, placeholder: '작품 설명' });
    desc.value = e.description;

    const save = async () => {
      const { error } = await sb.from('entries').update({
        title: title.value.trim(), author: author.value.trim(), description: desc.value.trim(),
      }).eq('id', e.id);
      toast(error ? errorText(error) : '저장했습니다.');
    };
    const toggleHidden = async () => {
      const { error } = await sb.from('entries').update({ hidden: !e.hidden }).eq('id', e.id);
      if (error) { toast(errorText(error)); return; }
      loadEntries();
    };
    const remove = async () => {
      if (!confirm('"' + (e.title || '제목 없음') + '" 작품을 삭제할까요?\n이 작품의 하트와 댓글, 이미지 파일도 함께 삭제되며 되돌릴 수 없습니다.')) return;
      // 표에서 먼저 지우고(하트·댓글도 함께 삭제됨), 그다음 이미지 파일을 지웁니다.
      const del = await sb.from('entries').delete().eq('id', e.id);
      if (del.error) { toast(errorText(del.error)); return; }
      const rm = await sb.storage.from(cfg.BUCKET).remove([e.image_path]);
      toast(rm.error ? '작품은 삭제했지만 이미지 파일 삭제에 실패했습니다.' : '삭제했습니다.');
      loadEntries();
    };

    return h('div', { class: 'item' + (e.hidden ? ' is-hidden' : '') },
      h('img', { src: imageUrl(e.image_path), alt: '', loading: 'lazy' }),
      h('div', { class: 'fields two' },
        title, author, desc,
        h('div', { class: 'actions full' },
          h('button', { type: 'button', class: 'btn primary', onclick: save }, '저장'),
          h('button', { type: 'button', class: 'btn', onclick: toggleHidden }, e.hidden ? '다시 보이기' : '숨기기'),
          h('button', { type: 'button', class: 'btn danger', onclick: remove }, '삭제'),
          e.hidden ? h('span', { class: 'badge' }, '숨김') : null)));
  }

  // ----- 이벤트: 끌어다 놓기, 파일 선택, CSV -----
  const drop = $('dropZone');
  ['dragenter', 'dragover'].forEach((type) => drop.addEventListener(type, (ev) => {
    ev.preventDefault();
    drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((type) => drop.addEventListener(type, (ev) => {
    ev.preventDefault();
    drop.classList.remove('over');
  }));
  drop.addEventListener('drop', (ev) => addFiles(ev.dataTransfer.files));
  $('fileInput').addEventListener('change', (ev) => {
    addFiles(ev.target.files);
    ev.target.value = ''; // 같은 파일을 다시 고를 수 있게 비움
  });
  $('uploadBtn').addEventListener('click', uploadAll);

  $('csvInput').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    try {
      const rows = parseCsv(await readCsvFile(file));
      if (rows.length === 0) throw new Error('내용이 없는 CSV 입니다.');
      // 첫 줄이 제목 줄이면 열 이름으로 위치를 찾고, 아니면 순서(제목, 출품자, 설명, 파일명키워드)대로 읽습니다.
      const head = rows[0].map((x) => x.trim());
      const hasHeader = head.includes('제목');
      const col = (name, fallback) => (hasHeader && head.indexOf(name) >= 0 ? head.indexOf(name) : fallback);
      const iT = col('제목', 0), iA = col('출품자', 1), iD = col('설명', 2), iK = col('파일명키워드', 3);
      state.csvRows = rows.slice(hasHeader ? 1 : 0).map((r) => ({
        title: (r[iT] || '').trim(), author: (r[iA] || '').trim(),
        description: (r[iD] || '').trim(), keyword: (r[iK] || '').trim(),
      }));
      const matched = state.pending.filter(autoFill).length;
      $('csvInfo').textContent = state.csvRows.length + '개 항목을 불러왔습니다.'
        + (state.pending.length ? ' 자동 매칭 ' + matched + '/' + state.pending.length + '개' : '');
      renderPending();
    } catch (err) {
      toast('CSV 를 읽지 못했습니다. ' + errorText(err));
    }
  });

  // ==========================================================================
  //  4) 학생
  // ==========================================================================
  async function loadStudents() {
    state.students = await fetchAll(() => sb.from('students')
      .select('id, school, student_no, name, auth_uid, created_at, last_login_at')
      .order('school_norm').order('student_no').order('id'));
    renderStudents();
  }

  function filteredStudents() {
    const q = $('studentSearch').value.trim().toLowerCase();
    if (!q) return state.students;
    return state.students.filter((s) => (s.school + ' ' + s.student_no + ' ' + s.name).toLowerCase().includes(q));
  }

  function renderStudents() {
    const list = filteredStudents();
    $('studentCount').textContent = list.length + '명' + (list.length !== state.students.length ? ' / 전체 ' + state.students.length + '명' : '');
    renderTable($('studentTable'), ['학교', '학번', '이름', '마지막 로그인', '기기', ''],
      list.map((s) => [
        s.school, s.student_no, s.name,
        h('td', { class: 'nowrap' }, timeText(s.last_login_at)),
        s.auth_uid ? '연결됨' : '연결 없음',
        h('td', { class: 'nowrap' },
          s.auth_uid ? h('button', { type: 'button', class: 'btn', onclick: () => unlinkStudent(s) }, '연결 해제') : null,
          h('button', { type: 'button', class: 'btn danger', onclick: () => deleteStudent(s) }, '삭제')),
      ]), '로그인한 학생이 없습니다.');
  }

  // 기기 연결 해제: 하트·댓글은 그대로 두고, 지금 기기에서만 로그아웃시킵니다.
  // 학생이 다시 로그인하면 원래 프로필로 이어집니다.
  async function unlinkStudent(s) {
    if (!confirm(s.name + ' 학생의 기기 연결을 해제할까요?\n(하트와 댓글은 유지됩니다)')) return;
    const { error } = await sb.from('students').update({ auth_uid: null }).eq('id', s.id);
    if (error) { toast(errorText(error)); return; }
    toast('연결을 해제했습니다.');
    loadStudents();
  }

  async function deleteStudent(s) {
    if (!confirm(s.school + ' ' + s.student_no + ' ' + s.name + ' 프로필을 삭제할까요?\n이 학생의 하트와 댓글도 모두 삭제되며 되돌릴 수 없습니다.')) return;
    const { error } = await sb.from('students').delete().eq('id', s.id);
    if (error) { toast(errorText(error)); return; }
    toast('삭제했습니다.');
    loadStudents();
  }

  $('studentSearch').addEventListener('input', renderStudents);
  $('studentCsv').addEventListener('click', () => {
    downloadCsv('학생목록.csv', ['학교', '학번', '이름', '처음 로그인', '마지막 로그인', '기기 연결'],
      filteredStudents().map((s) => [s.school, s.student_no, s.name,
        timeText(s.created_at), timeText(s.last_login_at), s.auth_uid ? '연결됨' : '연결 없음']));
  });

  // ==========================================================================
  //  5) 댓글
  // ==========================================================================
  // 관리자는 댓글과 함께 실제 이름·학번·작품 제목을 봅니다. (students, entries 표를 함께 조회)
  function fetchComments() {
    return fetchAll(() => sb.from('comments')
      .select('id, body, hidden, created_at, students(school, student_no, name), entries(title)')
      .order('created_at', { ascending: false }).order('id'));
  }

  async function loadComments() {
    state.comments = await fetchComments();
    renderComments();
  }

  function renderComments() {
    const list = $('hiddenOnly').checked ? state.comments.filter((c) => c.hidden) : state.comments;
    $('commentCount').textContent = list.length + '개';
    renderTable($('commentTable'), ['작품', '작성자', '내용', '시각', ''],
      list.map((c) => {
        const s = c.students || {};
        return [
          (c.entries && c.entries.title) || '',
          h('td', { class: 'nowrap' }, (s.name || '') + ' (' + (s.school || '') + ' ' + (s.student_no || '') + ')'),
          h('td', { class: 'body' }, c.body, c.hidden ? h('span', { class: 'badge' }, '숨김') : null),
          h('td', { class: 'nowrap' }, timeText(c.created_at)),
          h('td', { class: 'nowrap' },
            h('button', { type: 'button', class: 'btn', onclick: () => setCommentHidden(c, !c.hidden) }, c.hidden ? '보이기' : '숨김'),
            h('button', { type: 'button', class: 'btn danger', onclick: () => deleteComment(c) }, '삭제')),
        ];
      }), '댓글이 없습니다.', (i) => (list[i].hidden ? 'is-hidden' : null));
  }

  async function setCommentHidden(c, hidden) {
    const { error } = await sb.from('comments').update({ hidden }).eq('id', c.id);
    if (error) { toast(errorText(error)); return; }
    c.hidden = hidden;
    renderComments();
  }

  async function deleteComment(c) {
    if (!confirm('이 댓글을 삭제할까요? 되돌릴 수 없습니다.')) return;
    const { error } = await sb.from('comments').delete().eq('id', c.id);
    if (error) { toast(errorText(error)); return; }
    state.comments = state.comments.filter((x) => x !== c);
    renderComments();
  }

  $('hiddenOnly').addEventListener('change', renderComments);

  // ==========================================================================
  //  6) 결과
  // ==========================================================================
  // 순위표 자료: 하트가 많은 순. 하트 수가 같으면 같은 순위(공동 순위)로 표시합니다.
  async function fetchRanking() {
    const [entries, stats] = await Promise.all([
      sb.from('entries').select('id, title, author, hidden, created_at'),
      sb.rpc('get_entry_stats'),
    ]);
    if (entries.error) throw entries.error;
    if (stats.error) throw stats.error;
    const byId = new Map(stats.data.map((r) => [r.entry_id, r]));
    const rows = entries.data.map((e) => {
      const st = byId.get(e.id) || {};
      return { ...e, likes: Number(st.like_count || 0), comments: Number(st.comment_count || 0) };
    }).sort((a, b) => b.likes - a.likes || new Date(a.created_at) - new Date(b.created_at));
    rows.forEach((r, i) => { r.rank = i > 0 && rows[i - 1].likes === r.likes ? rows[i - 1].rank : i + 1; });
    return rows;
  }

  async function loadResults() {
    const rows = await fetchRanking();
    renderTable($('resultTable'), ['순위', '제목', '출품자', '하트', '댓글'],
      rows.map((r) => [
        r.rank,
        h('td', {}, r.title || '제목 없음', r.hidden ? h('span', { class: 'badge' }, '숨김') : null),
        r.author,
        h('td', { class: 'num' }, r.likes),
        h('td', { class: 'num' }, r.comments),
      ]), '등록된 작품이 없습니다.', (i) => (rows[i].hidden ? 'is-hidden' : null));
  }

  // CSV 내려받기 버튼 공통 처리 (누르는 동안 잠깐 비활성화, 오류는 알림으로)
  function csvButton(id, work) {
    $(id).addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      try { await work(); } catch (err) { console.error(err); toast(errorText(err)); }
      ev.target.disabled = false;
    });
  }

  csvButton('csvSummary', async () => {
    const rows = await fetchRanking();
    downloadCsv('작품별_집계.csv', ['순위', '제목', '출품자', '하트 수', '댓글 수(숨김 제외)', '숨김 여부'],
      rows.map((r) => [r.rank, r.title, r.author, r.likes, r.comments, r.hidden ? '숨김' : '']));
  });

  csvButton('csvLikes', async () => {
    const likes = await fetchAll(() => sb.from('likes')
      .select('created_at, entries(title, author), students(school, student_no, name)')
      .order('created_at').order('entry_id').order('student_id'));
    downloadCsv('하트_상세.csv', ['작품', '출품자', '학교', '학번', '이름', '누른 시각'],
      likes.map((l) => [
        l.entries ? l.entries.title : '', l.entries ? l.entries.author : '',
        l.students ? l.students.school : '', l.students ? l.students.student_no : '',
        l.students ? l.students.name : '', timeText(l.created_at)]));
  });

  csvButton('csvComments', async () => {
    const comments = await fetchComments();
    downloadCsv('댓글_상세.csv', ['작품', '학교', '학번', '이름', '내용', '숨김 여부', '쓴 시각'],
      comments.map((c) => [
        c.entries ? c.entries.title : '',
        c.students ? c.students.school : '', c.students ? c.students.student_no : '',
        c.students ? c.students.name : '', c.body, c.hidden ? '숨김' : '', timeText(c.created_at)]));
  });

  // ==========================================================================
  //  시작
  // ==========================================================================
  enter().catch((err) => {
    console.error(err);
    showView('login');
    showError($('loginError'), err);
  });
})();
