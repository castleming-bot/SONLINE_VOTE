// ============================================================================
//  app.js - 학생 화면(index.html)의 동작
// ============================================================================
//  흐름 요약
//    1) 페이지가 열리면 설정·작품·집계(하트 수 등)를 불러와 갤러리를 그립니다.
//    2) 하트나 댓글을 쓰려면 로그인(학교·학번·이름)이 필요합니다.
//       - 내부적으로는 Supabase "익명 로그인"으로 기기에 임시 계정을 만들고,
//       - DB 함수 claim_student 로 그 계정을 학생 프로필에 연결합니다.
//    3) 하트·댓글은 모두 DB 함수(rpc)로만 보냅니다. 검사는 DB가 다시 합니다.
//
//  보안 메모: 화면에 글자를 넣을 때는 항상 textContent 를 씁니다.
//            (innerHTML 에 사용자가 쓴 글을 넣으면 악성 코드가 실행될 수 있기 때문)
// ============================================================================
(function () {
  'use strict';

  const cfg = window.APP_CONFIG;

  // Supabase 연결. storageKey 를 따로 주어 관리자 화면(admin.html)의 로그인과 섞이지 않게 합니다.
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { storageKey: 'vote-student', persistSession: true, autoRefreshToken: true },
  });

  // ----- 화면 전체가 공유하는 상태 -----
  const state = {
    settings: { site_title: '', site_notice: '', voting_open: false },
    entries: [],        // 작품 목록
    stats: new Map(),   // 작품 id → { like_count, comment_count, liked_by_me }
    student: null,      // 로그인한 학생 { id, school, student_no, name } 또는 null
    sort: 'random',     // random | popular | latest
    current: null,      // 상세 창에 열려 있는 작품 id
    busyLike: new Set(), // 하트 요청이 진행 중인 작품 id (연타 방지)
  };

  const ORDER_KEY = 'vote-random-order'; // 랜덤 순서를 세션 동안 기억하는 저장 이름
  const MAX_COMMENT = 200;

  // 하트 아이콘(고정된 그림이라 innerHTML 로 넣어도 안전합니다)
  const HEART_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-10-9.3C.3 8.4 2 4.5 5.8 4.5c2.2 0 3.6 1.2 4.4 2.4h3.6c.8-1.2 2.2-2.4 4.4-2.4 3.8 0 5.5 3.9 3.8 7.2C19.5 16.4 12 21 12 21z" stroke-linejoin="round"/></svg>';

  // ----- 자주 쓰는 도우미 -----
  const $ = (id) => document.getElementById(id);

  // h('p', { class: 'a' }, '글자') 처럼 요소를 만드는 작은 도우미
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children) {
      if (c === null || c === undefined) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  // 작품 이미지의 공개 주소
  function imageUrl(path) {
    return sb.storage.from(cfg.BUCKET).getPublicUrl(path).data.publicUrl;
  }

  // 잠깐 떴다 사라지는 알림
  let toastTimer;
  function toast(message) {
    const el = $('toast');
    // 열려 있는 창(dialog)은 화면 맨 위층에 그려지므로, 알림도 그 안으로 옮겨야 보입니다.
    const host = $('login').open ? $('login') : $('detail').open ? $('detail') : document.body;
    host.append(el);
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
  }

  // 오류를 학생이 이해할 수 있는 한국어 문장으로 바꿉니다.
  function errorText(err) {
    const msg = (err && err.message) || '';
    // DB에 표·함수가 아직 없을 때 (schema.sql 을 실행하지 않은 경우)
    if (/^(PGRST202|PGRST205|42P01|42883)$/.test((err && err.code) || '')) {
      return '사이트 준비가 아직 끝나지 않았습니다. (DB 설정 필요)';
    }
    if (/Anonymous sign-ins are disabled/i.test(msg)) {
      return '익명 로그인이 꺼져 있습니다. 선생님께 알려 주세요.';
    }
    if (/rate limit/i.test(msg)) {
      return '지금 접속이 많습니다. 잠시 후 다시 시도해 주세요.';
    }
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
      return '인터넷 연결을 확인해 주세요.';
    }
    // DB 함수가 보낸 안내(한글)는 그대로 보여 줍니다.
    if (/[가-힣]/.test(msg)) return msg;
    return '문제가 생겼습니다. 잠시 후 다시 시도해 주세요.';
  }

  // "로그인이 필요합니다" 류의 오류인지 (다른 기기에서 로그인해 연결이 끊긴 경우 등)
  const isLoginError = (err) => /로그인이 필요/.test((err && err.message) || '');

  function timeText(iso) {
    return new Date(iso).toLocaleString('ko-KR', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function statOf(id) {
    if (!state.stats.has(id)) {
      state.stats.set(id, { like_count: 0, comment_count: 0, liked_by_me: false });
    }
    return state.stats.get(id);
  }

  // ==========================================================================
  //  데이터 불러오기
  // ==========================================================================

  // 지금 기기에 연결된 학생 프로필을 확인합니다. (새로고침해도 로그인 유지)
  async function loadStudent() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { state.student = null; return; }
    // 보안 정책상 본인 프로필만 조회됩니다. 다른 기기에서 로그인했다면 결과가 없습니다.
    const { data } = await sb.from('students')
      .select('id, school, student_no, name')
      .eq('auth_uid', session.user.id)
      .maybeSingle();
    state.student = data || null;
  }

  // 작품별 하트 수·댓글 수·내가 눌렀는지
  async function loadStats() {
    const { data, error } = await sb.rpc('get_entry_stats');
    if (error) throw error;
    state.stats = new Map(data.map((r) => [r.entry_id, {
      like_count: Number(r.like_count),
      comment_count: Number(r.comment_count),
      liked_by_me: r.liked_by_me,
    }]));
  }

  async function loadAll() {
    showSkeleton();
    try {
      await loadStudent();
      const [settings, entries] = await Promise.all([
        sb.from('settings').select('site_title, site_notice, voting_open').eq('id', 1).maybeSingle(),
        sb.from('entries').select('id, title, author, description, image_path, created_at').eq('hidden', false),
        loadStats(),
      ]);
      if (settings.error) throw settings.error;
      if (entries.error) throw entries.error;
      if (settings.data) state.settings = settings.data;
      state.entries = entries.data;
      renderHeader();
      renderGrid();
    } catch (err) {
      console.error(err);
      showState('작품을 불러오지 못했습니다. ' + errorText(err), '다시 시도', loadAll);
    }
  }

  // ==========================================================================
  //  화면 그리기
  // ==========================================================================

  function renderHeader() {
    const s = state.settings;
    if (s.site_title) {
      $('siteTitle').textContent = s.site_title;
      document.title = s.site_title;
    }
    $('siteNotice').textContent = s.site_notice || '';
    $('closedBanner').hidden = s.voting_open;
    renderUserBox();
  }

  function renderUserBox() {
    const box = $('userBox');
    box.replaceChildren();
    if (state.student) {
      box.append(
        h('span', { class: 'user-name' }, state.student.name),
        h('button', { type: 'button', class: 'btn', onclick: logout }, '로그아웃'),
      );
    } else {
      box.append(h('button', { type: 'button', class: 'btn primary', onclick: openLogin }, '로그인'));
    }
  }

  // 로딩 중 뼈대
  function showSkeleton() {
    $('state').hidden = true;
    const grid = $('grid');
    grid.replaceChildren();
    for (let i = 0; i < 8; i++) {
      grid.append(h('div', { class: 'card skeleton' },
        h('div', { class: 'card-img' }), h('div', { class: 'line' })));
    }
  }

  // 빈 목록·오류 안내
  function showState(message, buttonText, onClick) {
    $('grid').replaceChildren();
    const box = $('state');
    box.replaceChildren(h('p', {}, message));
    if (buttonText) box.append(h('button', { type: 'button', class: 'btn', onclick: onClick }, buttonText));
    box.hidden = false;
  }

  // 배열을 무작위로 섞기 (피셔-예이츠 방법)
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // 랜덤 순서: 한 번 정한 순서를 sessionStorage 에 저장해, 탭을 닫기 전까지 그대로 유지합니다.
  // (새로고침할 때마다 순서가 바뀌면 보던 작품을 다시 찾기 어렵기 때문)
  function randomOrder(ids) {
    let saved = [];
    try { saved = JSON.parse(sessionStorage.getItem(ORDER_KEY)) || []; } catch (e) { /* 무시 */ }
    const alive = new Set(ids);
    const kept = saved.filter((id) => alive.has(id));
    const keptSet = new Set(kept);
    const order = kept.concat(shuffle(ids.filter((id) => !keptSet.has(id)))); // 새 작품은 뒤에
    try { sessionStorage.setItem(ORDER_KEY, JSON.stringify(order)); } catch (e) { /* 무시 */ }
    return order;
  }

  function sortedEntries() {
    const list = state.entries.slice();
    if (state.sort === 'popular') {
      list.sort((a, b) => statOf(b.id).like_count - statOf(a.id).like_count
        || new Date(a.created_at) - new Date(b.created_at));
    } else if (state.sort === 'latest') {
      list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    } else {
      const pos = new Map(randomOrder(list.map((e) => e.id)).map((id, i) => [id, i]));
      list.sort((a, b) => pos.get(a.id) - pos.get(b.id));
    }
    return list;
  }

  // 하트 버튼 하나를 만듭니다. big = 상세 창의 큰 버튼
  function heartButton(entryId, big) {
    const st = statOf(entryId);
    const open = state.settings.voting_open;
    // 투표 기간이 아니면 누를 수 없는 표시(span)로 바꿉니다.
    const el = h(open ? 'button' : 'span', {
      class: 'heart' + (big ? ' big' : '') + (st.liked_by_me ? ' on' : '') + (open ? '' : ' readonly'),
      type: open ? 'button' : null,
      'data-heart': entryId,
      'aria-pressed': open ? String(st.liked_by_me) : null,
      'aria-label': open ? '하트' : null,
    });
    el.innerHTML = HEART_SVG;
    el.append(h('span', { class: 'n' }, st.like_count));
    if (open) el.addEventListener('click', (ev) => { ev.stopPropagation(); toggleLike(entryId); });
    return el;
  }

  // 화면에 있는 같은 작품의 하트 버튼(카드 + 상세 창)을 모두 최신 상태로 맞춥니다.
  function syncHearts(entryId, animate) {
    const st = statOf(entryId);
    document.querySelectorAll('[data-heart="' + entryId + '"]').forEach((el) => {
      el.classList.toggle('on', st.liked_by_me);
      if (el.hasAttribute('aria-pressed')) el.setAttribute('aria-pressed', String(st.liked_by_me));
      el.querySelector('.n').textContent = st.like_count;
      if (animate) {
        el.classList.remove('pop');
        void el.offsetWidth; // 애니메이션을 처음부터 다시 재생시키는 요령
        el.classList.add('pop');
      }
    });
  }

  function renderGrid() {
    const grid = $('grid');
    if (state.entries.length === 0) {
      showState('아직 등록된 작품이 없습니다.');
      return;
    }
    $('state').hidden = true;
    grid.replaceChildren();
    for (const e of sortedEntries()) {
      grid.append(
        h('article', { class: 'card' },
          h('button', {
            type: 'button', class: 'card-img',
            'aria-label': (e.title || '작품') + ' 크게 보기',
            onclick: () => openDetail(e.id),
          }, h('img', { src: imageUrl(e.image_path), alt: e.title || '', loading: 'lazy' })),
          h('div', { class: 'card-body' },
            h('div', { class: 'card-text' },
              h('h2', {}, e.title || '제목 없음'),
              h('p', {}, e.author || '')),
            heartButton(e.id, false)),
        ));
    }
  }

  // ==========================================================================
  //  로그인 / 로그아웃
  // ==========================================================================

  function openDialog(dlg) {
    if (!dlg.open) dlg.showModal();
    document.body.classList.add('modal-open');
  }

  function openLogin() {
    $('loginError').hidden = true;
    openDialog($('login'));
    $('inSchool').focus();
  }

  async function submitLogin(ev) {
    ev.preventDefault();
    const btn = $('loginSubmit');
    const errBox = $('loginError');
    errBox.hidden = true;
    btn.disabled = true;
    btn.textContent = '확인 중…';
    try {
      // 1) 기기에 임시 계정이 없으면 익명 로그인으로 만듭니다.
      const { data: { session } } = await sb.auth.getSession();
      if (!session) {
        const { error } = await sb.auth.signInAnonymously();
        if (error) throw error;
      }
      // 2) 학교·학번·이름으로 학생 프로필을 이 기기에 연결합니다. (검사는 DB 함수가 수행)
      const { data, error } = await sb.rpc('claim_student', {
        p_school: $('inSchool').value,
        p_student_no: $('inNo').value,
        p_name: $('inName').value,
        p_consent: $('inConsent').checked,
      });
      if (error) throw error;
      state.student = data;
      // 3) "내가 누른 하트" 표시를 위해 집계를 다시 불러옵니다.
      await loadStats();
      $('login').close();
      $('loginForm').reset();
      renderUserBox();
      renderGrid();
      if (state.current) renderDetail();
      toast(data.name + '님, 환영합니다!');
    } catch (err) {
      console.error(err);
      errBox.textContent = errorText(err);
      errBox.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = '로그인';
    }
  }

  async function logout() {
    await sb.auth.signOut({ scope: 'local' });
    state.student = null;
    state.stats.forEach((st) => { st.liked_by_me = false; });
    renderUserBox();
    renderGrid();
    toast('로그아웃했습니다.');
  }

  // 로그인·투표 기간을 확인하고, 안 되면 안내합니다. 되면 true.
  function canWrite() {
    if (!state.settings.voting_open) { toast('지금은 투표 기간이 아닙니다.'); return false; }
    if (!state.student) { openLogin(); return false; }
    return true;
  }

  // 연결이 끊긴 것으로 확인되면 로그인 상태를 지우고 다시 로그인하게 합니다.
  function handleLostLogin() {
    state.student = null;
    renderUserBox();
    openLogin();
  }

  // ==========================================================================
  //  하트 (낙관적 업데이트)
  // ==========================================================================
  //  낙관적 업데이트란? 서버 응답을 기다리지 않고 화면부터 바꾸는 방법입니다.
  //  누르는 즉시 반응해서 빠르게 느껴지고, 서버가 거절하면 원래대로 되돌립니다.
  // ==========================================================================
  async function toggleLike(entryId) {
    if (!canWrite()) return;
    if (state.busyLike.has(entryId)) return; // 이전 요청이 끝날 때까지 연타 무시
    state.busyLike.add(entryId);

    const st = statOf(entryId);
    const before = { liked: st.liked_by_me, count: st.like_count };

    // 1) 화면부터 바꿉니다.
    st.liked_by_me = !before.liked;
    st.like_count = Math.max(0, before.count + (st.liked_by_me ? 1 : -1));
    syncHearts(entryId, true);

    // 2) 서버에 알리고, 서버가 알려 준 실제 값으로 맞춥니다.
    const { data, error } = await sb.rpc('toggle_like', { p_entry_id: entryId });
    if (error) {
      // 3) 실패하면 되돌립니다.
      st.liked_by_me = before.liked;
      st.like_count = before.count;
      syncHearts(entryId, false);
      if (isLoginError(error)) handleLostLogin();
      else toast(errorText(error));
    } else {
      st.liked_by_me = data.liked;
      st.like_count = Number(data.like_count);
      syncHearts(entryId, false);
    }
    state.busyLike.delete(entryId);
  }

  // ==========================================================================
  //  작품 상세 창 + 댓글
  // ==========================================================================

  function openDetail(entryId) {
    state.current = entryId;
    renderDetail();
    openDialog($('detail'));
    $('detail').scrollTop = 0;
    loadComments(entryId);
  }

  function renderDetail() {
    const e = state.entries.find((x) => x.id === state.current);
    if (!e) return;
    const open = state.settings.voting_open;

    $('detailImg').src = imageUrl(e.image_path);
    $('detailImg').alt = e.title || '';
    $('detailTitle').textContent = e.title || '제목 없음';
    $('detailAuthor').textContent = e.author || '';
    $('detailDesc').textContent = e.description || '';
    $('detailCommentCount').textContent = statOf(e.id).comment_count;

    // 하트: 투표 중이면 큰 버튼, 아니면 안내 문구
    $('detailHeart').replaceChildren(open
      ? heartButton(e.id, true)
      : h('p', { class: 'closed-note' }, '지금은 투표 기간이 아니어서 하트를 누를 수 없습니다. (하트 ' + statOf(e.id).like_count + '개)'));

    // 댓글 입력: 투표 중이면 입력 칸, 아니면 안내 문구
    const box = $('commentBox');
    if (!open) {
      box.replaceChildren(h('p', { class: 'closed-note' }, '지금은 투표 기간이 아니어서 댓글을 쓸 수 없습니다.'));
      return;
    }
    const counter = h('span', { class: 'counter' }, '0 / ' + MAX_COMMENT);
    const textarea = h('textarea', {
      placeholder: state.student ? '응원의 한마디를 남겨 주세요.' : '로그인하면 댓글을 쓸 수 있어요.',
      'aria-label': '댓글 입력',
    });
    const submit = h('button', { type: 'submit', class: 'btn primary' }, '댓글 쓰기');
    textarea.addEventListener('input', () => {
      const n = textarea.value.trim().length;
      counter.textContent = n + ' / ' + MAX_COMMENT;
      counter.classList.toggle('over', n > MAX_COMMENT);
    });
    // 로그인 전에 입력 칸을 누르면 로그인 창을 엽니다.
    textarea.addEventListener('focus', () => { if (!state.student) { textarea.blur(); openLogin(); } });
    const form = h('form', { class: 'comment-form' }, textarea, h('div', { class: 'row' }, counter, submit));
    form.addEventListener('submit', (ev) => { ev.preventDefault(); addComment(e.id, textarea, submit, counter); });
    box.replaceChildren(form);
  }

  async function loadComments(entryId) {
    const list = $('commentList');
    list.replaceChildren(h('li', { class: 'empty' }, '댓글을 불러오는 중…'));
    const { data, error } = await sb.rpc('get_comments', { p_entry_id: entryId });
    if (state.current !== entryId) return; // 그 사이 다른 작품을 열었으면 버림
    if (error) {
      list.replaceChildren(h('li', { class: 'empty' }, '댓글을 불러오지 못했습니다.'));
      return;
    }
    list.replaceChildren();
    data.forEach((c) => list.append(commentItem(entryId, c)));
    setCommentCount(entryId, data.length);
  }

  function setCommentCount(entryId, n) {
    statOf(entryId).comment_count = n;
    if (state.current === entryId) $('detailCommentCount').textContent = n;
    const list = $('commentList');
    const empty = list.querySelector('.empty');
    if (n === 0 && !empty) list.append(h('li', { class: 'empty' }, '첫 댓글을 남겨 보세요.'));
    if (n > 0 && empty) empty.remove();
  }

  // 댓글 한 줄. 이름은 DB가 이미 가려서(예: 강*욱) 보내 줍니다.
  function commentItem(entryId, c) {
    const li = h('li', {},
      h('div', { class: 'meta' },
        h('strong', {}, c.masked_name),
        h('span', {}, timeText(c.created_at)),
        // 본인 댓글이고 투표 중일 때만 삭제 버튼
        c.is_mine && state.settings.voting_open
          ? h('button', { type: 'button', onclick: () => deleteComment(entryId, c.id, li) }, '삭제')
          : null),
      h('p', { class: 'body' }, c.body));
    return li;
  }

  async function addComment(entryId, textarea, submit, counter) {
    if (!canWrite()) return;
    const body = textarea.value.trim();
    if (body.length === 0) { toast('댓글 내용을 입력해 주세요.'); return; }
    if (body.length > MAX_COMMENT) { toast('댓글은 ' + MAX_COMMENT + '자까지 쓸 수 있습니다.'); return; }

    submit.disabled = true;
    const { data, error } = await sb.rpc('add_comment', { p_entry_id: entryId, p_body: body });
    submit.disabled = false;
    if (error) {
      if (isLoginError(error)) handleLostLogin();
      else toast(errorText(error));
      return;
    }
    textarea.value = '';
    counter.textContent = '0 / ' + MAX_COMMENT;
    if (state.current === entryId) {
      const li = commentItem(entryId, data);
      $('commentList').append(li);
      li.scrollIntoView({ block: 'nearest' });
    }
    setCommentCount(entryId, statOf(entryId).comment_count + 1);
  }

  async function deleteComment(entryId, commentId, li) {
    if (!confirm('이 댓글을 삭제할까요?')) return;
    const { error } = await sb.rpc('delete_my_comment', { p_comment_id: commentId });
    if (error) {
      if (isLoginError(error)) handleLostLogin();
      else toast(errorText(error));
      return;
    }
    li.remove();
    setCommentCount(entryId, Math.max(0, statOf(entryId).comment_count - 1));
  }

  // ==========================================================================
  //  이벤트 연결 + 시작
  // ==========================================================================

  // 정렬 버튼
  document.querySelectorAll('.sort button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.sort = btn.dataset.sort;
      document.querySelectorAll('.sort button').forEach((b) => b.classList.toggle('on', b === btn));
      if (state.entries.length) renderGrid();
    });
  });

  // 창 닫기: × 버튼, 창 바깥(어두운 부분) 클릭, Esc 키(브라우저 기본)
  document.querySelectorAll('dialog').forEach((dlg) => {
    dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
    dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); });
    dlg.addEventListener('close', () => {
      if (dlg.id === 'detail') state.current = null;
      if (!document.querySelector('dialog[open]')) document.body.classList.remove('modal-open');
    });
  });

  $('loginForm').addEventListener('submit', submitLogin);

  loadAll();
})();
