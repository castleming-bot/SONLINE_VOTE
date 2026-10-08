-- ============================================================================
--  학교 캐릭터 공모전 투표 사이트 - 데이터베이스 설계도 (schema.sql)
-- ============================================================================
--  사용법
--    Supabase 대시보드 → SQL Editor → New query → 이 파일 전체를 붙여넣고 Run.
--    여러 번 실행해도 안전합니다. (이미 있는 표·데이터는 그대로 두고,
--    함수와 보안 정책만 최신 내용으로 다시 만듭니다.)
--
--  이 파일이 만드는 것
--    1. 표(table) 7개 : settings, secrets, admins, students, entries, likes, comments
--    2. 도우미 함수   : 학교 이름 정규화, 이름 마스킹, 관리자 판정 등
--    3. 보안 정책(RLS): "누가 어떤 줄을 볼 수 있는가"
--    4. 학생용 함수   : claim_student, toggle_like, add_comment, delete_my_comment
--    5. 조회용 함수   : get_entry_stats, get_comments
--    6. 관리자용 함수 : register_admin, remove_admin
--    7. Storage 버킷  : entries (작품 이미지 보관함)
--
--  보안의 큰 그림
--    - 이 사이트의 코드는 GitHub Pages에 공개되므로, 브라우저가 가진 열쇠(anon key)는
--      누구나 볼 수 있습니다. 따라서 "브라우저를 믿지 않고 DB가 직접 검사"합니다.
--    - 학생은 표에 직접 쓰지 못합니다. 반드시 아래의 함수를 거쳐야 하고,
--      함수 안에서 투표 기간·본인 여부·글자 수를 다시 확인합니다.
--    - 용어: anon = 로그인하지 않은 방문자, authenticated = 로그인한 사용자
--            (익명 로그인한 학생과 이메일로 로그인한 교사가 모두 여기에 속합니다.)
-- ============================================================================


-- ============================================================================
-- 1. 표 만들기
-- ============================================================================

-- ---------------------------------------------------------------------------
-- settings : 사이트 설정. 항상 딱 한 줄(id = 1)만 존재합니다.
-- ---------------------------------------------------------------------------
create table if not exists public.settings (
  id          int primary key default 1 check (id = 1),   -- 한 줄만 허용
  site_title  text not null default '캐릭터 공모전 투표',  -- 사이트 제목
  site_notice text not null default '마음에 드는 캐릭터에 하트를 눌러 주세요!', -- 안내문
  voting_open boolean not null default false,              -- true = 투표 진행 중
  updated_at  timestamptz not null default now()
);

-- 설정 줄이 없으면 기본값으로 한 줄 만들어 둡니다.
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- secrets : 비밀 값 보관함. 브라우저에서는 절대 읽을 수 없습니다.
--           (정책을 하나도 만들지 않고 권한도 주지 않으므로, 함수 안에서만 읽힙니다.)
-- ---------------------------------------------------------------------------
create table if not exists public.secrets (
  key   text primary key,
  value text not null
);

-- 관리자 가입 코드. 기본값은 sonline 입니다.
-- 이미 값이 있으면 덮어쓰지 않으므로, 코드를 바꾼 뒤 이 파일을 다시 실행해도 유지됩니다.
-- 코드 변경 방법:
--   update public.secrets set value = '새코드' where key = 'admin_signup_code';
insert into public.secrets (key, value)
values ('admin_signup_code', 'sonline')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- admins : 관리자(교사) 명단.
--          user_id 는 Supabase 로그인 계정(auth.users)의 고유 번호입니다.
--          계정이 삭제되면 이 줄도 함께 사라집니다(on delete cascade).
-- ---------------------------------------------------------------------------
create table if not exists public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text not null unique,          -- 소문자로 저장
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- students : 로그인한 학생 프로필.
--            미리 등록한 명단은 없고, 학생이 처음 로그인할 때 만들어집니다.
-- ---------------------------------------------------------------------------
create table if not exists public.students (
  id            uuid primary key default gen_random_uuid(),
  school        text not null,       -- 학생이 입력한 학교 이름 그대로
  school_norm   text not null,       -- 비교용 학교 이름 (띄어쓰기·"학교" 꼬리 제거)
  student_no    text not null,       -- 학번
  name          text not null,       -- 실제 이름 (학생 본인과 관리자만 볼 수 있음)
  auth_uid      uuid unique,         -- 지금 연결된 기기(익명 로그인 계정). 비어 있으면 연결 없음
  consent_at    timestamptz,         -- 개인정보 수집·이용에 동의한 시각
  created_at    timestamptz not null default now(),
  last_login_at timestamptz not null default now()
);

-- [중복 투표 차단] 같은 (정규화한 학교, 학번)으로는 프로필을 1개만 만들 수 있습니다.
create unique index if not exists students_school_no_key
  on public.students (school_norm, student_no);

-- ---------------------------------------------------------------------------
-- entries : 출품작.
-- ---------------------------------------------------------------------------
create table if not exists public.entries (
  id          uuid primary key default gen_random_uuid(),
  title       text not null default '',     -- 작품 제목
  author      text not null default '',     -- 출품자
  description text not null default '',     -- 작품 설명
  image_path  text not null,                -- Storage 버킷 안의 파일 경로
  hidden      boolean not null default false, -- true = 학생에게 보이지 않음
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- likes : 하트. (작품, 학생) 쌍이 기본 키이므로 작품당 1인 1회만 가능합니다.
--         작품이나 학생이 삭제되면 하트도 함께 삭제됩니다.
-- ---------------------------------------------------------------------------
create table if not exists public.likes (
  entry_id   uuid not null references public.entries (id)  on delete cascade,
  student_id uuid not null references public.students (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (entry_id, student_id)
);

create index if not exists likes_student_idx on public.likes (student_id);

-- ---------------------------------------------------------------------------
-- comments : 댓글.
--            masked_name 은 저장하는 순간에 가린 이름(예: 강*욱)입니다.
--            학생에게는 이 값만 전달되므로 실제 이름이 새어 나갈 길이 없습니다.
-- ---------------------------------------------------------------------------
create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  entry_id    uuid not null references public.entries (id)  on delete cascade,
  student_id  uuid not null references public.students (id) on delete cascade,
  masked_name text not null,
  body        text not null check (char_length(body) between 1 and 200),
  hidden      boolean not null default false,   -- 관리자가 숨긴 댓글
  created_at  timestamptz not null default now()
);

create index if not exists comments_entry_idx   on public.comments (entry_id, created_at);
create index if not exists comments_student_idx on public.comments (student_id);


-- ============================================================================
-- 2. 도우미 함수
-- ============================================================================

-- ---------------------------------------------------------------------------
-- normalize_school : 학교 이름을 비교하기 좋게 다듬습니다.
--   1) 모든 띄어쓰기 제거   2) 영문은 소문자로   3) 끝의 "등학교" 또는 "학교" 제거
--   예) "한국 고등학교" → "한국고",  "한국고" → "한국고",  "한국중학교" → "한국중"
--   그래서 "한국고"와 "한국 고등학교"는 같은 학교로 취급됩니다.
-- ---------------------------------------------------------------------------
create or replace function public.normalize_school(p_school text)
returns text
language sql
immutable
set search_path = public
as $$
  select regexp_replace(
           regexp_replace(lower(coalesce(p_school, '')), '\s+', '', 'g'),
           '(등학교|학교)$', ''
         );
$$;

-- ---------------------------------------------------------------------------
-- mask_name : 이름 가운데를 * 로 가립니다.
--   1글자 → 그대로,  2글자 → "강*",  3글자 이상 → 첫 글자 + * + 마지막 글자
--   예) "강현욱" → "강*욱",  "남궁민수" → "남**수"
-- ---------------------------------------------------------------------------
create or replace function public.mask_name(p_name text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when char_length(n) <= 1 then n
    when char_length(n) = 2 then left(n, 1) || '*'
    else left(n, 1) || repeat('*', char_length(n) - 2) || right(n, 1)
  end
  from (select btrim(coalesce(p_name, '')) as n) t;
$$;

-- ---------------------------------------------------------------------------
-- is_admin : 지금 요청한 사람이 관리자인지 판정합니다.
--   세 가지를 모두 만족해야 관리자입니다.
--     1) 익명 로그인 계정이 아닐 것 (학생은 전부 익명 로그인)
--     2) admins 표에 본인 계정 번호(user_id)가 있을 것
--     3) 그 줄의 이메일이 로그인한 이메일과 같을 것
--   SECURITY DEFINER : admins 표를 직접 볼 권한이 없는 사람도 이 함수로 판정만 받을 수 있게 합니다.
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
     and exists (
           select 1
           from public.admins a
           where a.user_id = auth.uid()
             and a.email = lower(coalesce(auth.jwt() ->> 'email', ''))
         );
$$;

-- ---------------------------------------------------------------------------
-- current_student_id : 지금 기기에 연결된 학생 프로필 번호. 없으면 null.
--   다른 기기에서 다시 로그인하면 auth_uid 가 새 기기로 바뀌므로,
--   이전 기기에서는 null 이 나와 투표할 수 없게 됩니다.
-- ---------------------------------------------------------------------------
create or replace function public.current_student_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select s.id from public.students s where s.auth_uid = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- voting_is_open : 투표가 진행 중인지 여부.
-- ---------------------------------------------------------------------------
create or replace function public.voting_is_open()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select voting_open from public.settings where id = 1), false);
$$;


-- ============================================================================
-- 3. 권한과 보안 정책 (RLS)
-- ============================================================================
--  두 겹으로 막습니다.
--    1겹) GRANT  : 역할(anon / authenticated)이 표에 어떤 동작을 할 수 있는가
--    2겹) POLICY : 그중에서도 "어떤 줄"에 할 수 있는가
--  둘 다 통과해야 실제로 읽거나 쓸 수 있습니다.
-- ============================================================================

-- 모든 표에 RLS 켜기 (정책이 없는 동작은 전부 거부됩니다)
alter table public.settings enable row level security;
alter table public.secrets  enable row level security;
alter table public.admins   enable row level security;
alter table public.students enable row level security;
alter table public.entries  enable row level security;
alter table public.likes    enable row level security;
alter table public.comments enable row level security;

-- Supabase 는 기본으로 넓은 권한을 주므로, 일단 전부 거둔 뒤 필요한 것만 다시 줍니다.
revoke all on public.settings, public.secrets, public.admins, public.students,
              public.entries, public.likes, public.comments
  from anon, authenticated;

-- 누구나(로그인 전 포함) : 설정과 작품 읽기
grant select on public.settings, public.entries to anon, authenticated;

-- 로그인한 사용자 : 아래 권한은 정책에서 다시 "본인 것만" 또는 "관리자만"으로 좁혀집니다.
grant select                         on public.students to authenticated; -- 본인 프로필 / 관리자
grant update, delete                 on public.students to authenticated; -- 관리자만
grant update                         on public.settings to authenticated; -- 관리자만
grant insert, update, delete         on public.entries  to authenticated; -- 관리자만
grant select, delete                 on public.likes    to authenticated; -- 관리자만
grant select, update, delete         on public.comments to authenticated; -- 관리자만
grant select                         on public.admins   to authenticated; -- 관리자만
-- secrets 표에는 아무 권한도 주지 않습니다.

-- ----- settings ------------------------------------------------------------
drop policy if exists settings_read  on public.settings;
drop policy if exists settings_admin on public.settings;

create policy settings_read on public.settings
  for select to anon, authenticated
  using (true);

create policy settings_admin on public.settings
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ----- admins --------------------------------------------------------------
-- 관리자만 명단을 볼 수 있습니다. 추가·삭제는 아래의 함수로만 가능합니다.
drop policy if exists admins_read on public.admins;

create policy admins_read on public.admins
  for select to authenticated
  using (public.is_admin());

-- ----- students ------------------------------------------------------------
-- 학생은 "지금 이 기기에 연결된 본인 프로필"만 볼 수 있습니다.
drop policy if exists students_read_own     on public.students;
drop policy if exists students_admin_read   on public.students;
drop policy if exists students_admin_update on public.students;
drop policy if exists students_admin_delete on public.students;

create policy students_read_own on public.students
  for select to authenticated
  using (auth_uid = (select auth.uid()));

create policy students_admin_read on public.students
  for select to authenticated
  using (public.is_admin());

-- 기기 연결 해제(auth_uid 를 비움)에 사용
create policy students_admin_update on public.students
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- 프로필 삭제. 그 학생의 하트·댓글도 함께 삭제됩니다(on delete cascade).
create policy students_admin_delete on public.students
  for delete to authenticated
  using (public.is_admin());

-- ----- entries -------------------------------------------------------------
drop policy if exists entries_read         on public.entries;
drop policy if exists entries_admin_insert on public.entries;
drop policy if exists entries_admin_update on public.entries;
drop policy if exists entries_admin_delete on public.entries;

-- 숨기지 않은 작품은 누구나, 숨긴 작품은 관리자만 볼 수 있습니다.
create policy entries_read on public.entries
  for select to anon, authenticated
  using (hidden = false or public.is_admin());

create policy entries_admin_insert on public.entries
  for insert to authenticated
  with check (public.is_admin());

create policy entries_admin_update on public.entries
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy entries_admin_delete on public.entries
  for delete to authenticated
  using (public.is_admin());

-- ----- likes ---------------------------------------------------------------
-- 학생은 하트 표를 직접 볼 수 없습니다. 개수와 "내가 눌렀는지"는 get_entry_stats 함수로만 받습니다.
drop policy if exists likes_admin_read   on public.likes;
drop policy if exists likes_admin_delete on public.likes;

create policy likes_admin_read on public.likes
  for select to authenticated
  using (public.is_admin());

create policy likes_admin_delete on public.likes
  for delete to authenticated
  using (public.is_admin());

-- ----- comments ------------------------------------------------------------
-- 학생은 댓글 표를 직접 볼 수 없습니다. get_comments 함수가 가린 이름만 돌려줍니다.
drop policy if exists comments_admin_read   on public.comments;
drop policy if exists comments_admin_update on public.comments;
drop policy if exists comments_admin_delete on public.comments;

create policy comments_admin_read on public.comments
  for select to authenticated
  using (public.is_admin());

-- 숨김 / 보이기
create policy comments_admin_update on public.comments
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy comments_admin_delete on public.comments
  for delete to authenticated
  using (public.is_admin());


-- ============================================================================
-- 4. 학생용 함수 (학생이 무언가를 "쓰는" 유일한 통로)
-- ============================================================================
--  SECURITY DEFINER 란?
--    함수를 "부른 사람"이 아니라 "만든 사람(관리 권한)"의 자격으로 실행한다는 뜻입니다.
--    학생에게는 표에 쓸 권한이 전혀 없지만, 이 함수 안에서는 쓸 수 있습니다.
--    대신 함수가 조건을 하나하나 검사한 뒤에만 써 줍니다.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- claim_student : 학교·학번·이름으로 학생 프로필을 "지금 이 기기"에 연결합니다.
--   - 처음 보는 (학교, 학번)이면 새 프로필을 만듭니다.
--   - 이미 있는 (학교, 학번)이면 이름이 같을 때만 연결합니다. (학번 도용 방지)
--   - 다른 기기에서 로그인하면 연결이 새 기기로 넘어가고, 이전 기기는 투표할 수 없습니다.
-- ---------------------------------------------------------------------------
create or replace function public.claim_student(
  p_school     text,
  p_student_no text,
  p_name       text,
  p_consent    boolean
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_school  text := btrim(coalesce(p_school, ''));
  v_no      text := regexp_replace(coalesce(p_student_no, ''), '\s+', '', 'g');
  v_name    text := btrim(coalesce(p_name, ''));
  v_norm    text;
  v_student public.students;
begin
  -- 1) 익명 로그인이 먼저 되어 있어야 합니다.
  if v_uid is null then
    raise exception '로그인 준비가 되지 않았습니다. 새로고침 후 다시 시도해 주세요.';
  end if;

  -- 2) 개인정보 수집·이용 동의 확인
  if p_consent is not true then
    raise exception '개인정보 수집·이용에 동의해야 참여할 수 있습니다.';
  end if;

  -- 3) 입력값 검사
  v_norm := public.normalize_school(v_school);
  if char_length(v_norm) < 1 or char_length(v_school) > 30 then
    raise exception '학교 이름을 정확히 입력해 주세요.';
  end if;
  if char_length(v_no) < 1 or char_length(v_no) > 20 then
    raise exception '학번을 정확히 입력해 주세요.';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 20 then
    raise exception '이름을 정확히 입력해 주세요.';
  end if;

  -- 4) 같은 (학교, 학번) 프로필이 있는지 찾습니다. (for update = 동시에 두 번 처리되지 않게 잠금)
  select * into v_student
  from public.students
  where school_norm = v_norm and student_no = v_no
  for update;

  -- 5) 이미 있는 프로필인데 이름이 다르면 거부합니다. (이름의 띄어쓰기는 무시하고 비교)
  if found and regexp_replace(v_student.name, '\s+', '', 'g')
            <> regexp_replace(v_name, '\s+', '', 'g') then
    raise exception '이미 다른 이름으로 등록된 학번입니다. 학교·학번·이름을 다시 확인해 주세요.';
  end if;

  -- 6) 이 기기가 다른 프로필에 연결되어 있었다면 그 연결을 먼저 끊습니다.
  --    (한 기기는 한 번에 한 프로필에만 연결됩니다.)
  update public.students
  set auth_uid = null
  where auth_uid = v_uid
    and (v_student.id is null or id <> v_student.id);

  if v_student.id is not null then
    -- 7-가) 기존 프로필 : 연결을 이 기기로 옮깁니다. 이전 기기는 이 순간부터 투표 불가.
    update public.students
    set auth_uid = v_uid, last_login_at = now()
    where id = v_student.id
    returning * into v_student;
  else
    -- 7-나) 새 프로필 만들기
    begin
      insert into public.students (school, school_norm, student_no, name, auth_uid, consent_at)
      values (v_school, v_norm, v_no, v_name, v_uid, now())
      returning * into v_student;
    exception when unique_violation then
      -- 아주 드물게 두 기기가 동시에 같은 학번으로 가입한 경우
      raise exception '잠시 후 다시 시도해 주세요.';
    end;
  end if;

  -- 8) 화면에 표시할 본인 정보만 돌려줍니다.
  return json_build_object(
    'id',         v_student.id,
    'school',     v_student.school,
    'student_no', v_student.student_no,
    'name',       v_student.name
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- toggle_like : 하트를 누르거나 취소합니다. (이미 눌렀으면 취소, 아니면 누름)
--   돌려주는 값 : { liked: 지금 눌린 상태인지, like_count: 그 작품의 하트 수 }
-- ---------------------------------------------------------------------------
create or replace function public.toggle_like(p_entry_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student uuid := public.current_student_id();
  v_liked   boolean;
  v_count   bigint;
begin
  -- 1) 투표 기간인지
  if not public.voting_is_open() then
    raise exception '지금은 투표 기간이 아닙니다.';
  end if;

  -- 2) 이 기기에 연결된 학생이 있는지 (다른 기기에서 로그인했다면 여기서 걸립니다)
  if v_student is null then
    raise exception '로그인이 필요합니다. 다시 로그인해 주세요.';
  end if;

  -- 3) 실제로 존재하고 공개된 작품인지
  if not exists (select 1 from public.entries where id = p_entry_id and hidden = false) then
    raise exception '작품을 찾을 수 없습니다.';
  end if;

  -- 4) 이미 눌렀으면 지우고, 아니면 추가합니다.
  delete from public.likes where entry_id = p_entry_id and student_id = v_student;
  if found then
    v_liked := false;
  else
    -- 빠르게 두 번 눌러 요청이 겹쳐도 기본 키 덕분에 하트는 1개만 남습니다.
    insert into public.likes (entry_id, student_id)
    values (p_entry_id, v_student)
    on conflict do nothing;
    v_liked := true;
  end if;

  select count(*) into v_count from public.likes where entry_id = p_entry_id;

  return json_build_object('liked', v_liked, 'like_count', v_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- add_comment : 댓글을 씁니다. 작성자 이름은 여기서 가려서 저장합니다.
-- ---------------------------------------------------------------------------
create or replace function public.add_comment(p_entry_id uuid, p_body text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student public.students;
  v_body    text := btrim(coalesce(p_body, ''));
  v_comment public.comments;
begin
  if not public.voting_is_open() then
    raise exception '지금은 투표 기간이 아닙니다.';
  end if;

  select * into v_student from public.students where auth_uid = auth.uid();
  if not found then
    raise exception '로그인이 필요합니다. 다시 로그인해 주세요.';
  end if;

  if not exists (select 1 from public.entries where id = p_entry_id and hidden = false) then
    raise exception '작품을 찾을 수 없습니다.';
  end if;

  -- 글자 수 검사 (화면에서도 막지만, 화면을 우회할 수 있으므로 여기서 다시 확인)
  if char_length(v_body) < 1 then
    raise exception '댓글 내용을 입력해 주세요.';
  end if;
  if char_length(v_body) > 200 then
    raise exception '댓글은 200자까지 쓸 수 있습니다.';
  end if;

  insert into public.comments (entry_id, student_id, masked_name, body)
  values (p_entry_id, v_student.id, public.mask_name(v_student.name), v_body)
  returning * into v_comment;

  -- get_comments 와 같은 모양으로 돌려주어 화면에 바로 덧붙일 수 있게 합니다.
  return json_build_object(
    'id',          v_comment.id,
    'masked_name', v_comment.masked_name,
    'body',        v_comment.body,
    'created_at',  v_comment.created_at,
    'is_mine',     true
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- delete_my_comment : 본인이 쓴 댓글만 지웁니다.
-- ---------------------------------------------------------------------------
create or replace function public.delete_my_comment(p_comment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student uuid := public.current_student_id();
begin
  if not public.voting_is_open() then
    raise exception '지금은 투표 기간이 아닙니다.';
  end if;

  if v_student is null then
    raise exception '로그인이 필요합니다. 다시 로그인해 주세요.';
  end if;

  delete from public.comments
  where id = p_comment_id and student_id = v_student;

  if not found then
    raise exception '본인이 쓴 댓글만 삭제할 수 있습니다.';
  end if;
end;
$$;


-- ============================================================================
-- 5. 조회용 함수 (로그인 전에도 사용 가능)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- get_entry_stats : 작품별 하트 수·댓글 수와 "내가 하트를 눌렀는지"를 한 번에 돌려줍니다.
--   누가 눌렀는지는 알려 주지 않고 숫자만 제공합니다.
-- ---------------------------------------------------------------------------
create or replace function public.get_entry_stats()
returns table (
  entry_id      uuid,
  like_count    bigint,
  comment_count bigint,
  liked_by_me   boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    e.id,
    (select count(*) from public.likes l where l.entry_id = e.id),
    (select count(*) from public.comments c where c.entry_id = e.id and c.hidden = false),
    exists (
      select 1 from public.likes l
      where l.entry_id = e.id and l.student_id = public.current_student_id()
    )
  from public.entries e
  where e.hidden = false or public.is_admin();
$$;

-- ---------------------------------------------------------------------------
-- get_comments : 한 작품의 댓글 목록. 가린 이름만 돌려주고, 숨긴 댓글은 제외합니다.
--   is_mine = true 인 댓글에만 화면에서 삭제 버튼을 보여 줍니다.
-- ---------------------------------------------------------------------------
create or replace function public.get_comments(p_entry_id uuid)
returns table (
  id          uuid,
  masked_name text,
  body        text,
  created_at  timestamptz,
  is_mine     boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    c.masked_name,
    c.body,
    c.created_at,
    coalesce(c.student_id = public.current_student_id(), false)
  from public.comments c
  join public.entries e on e.id = c.entry_id
  where c.entry_id = p_entry_id
    and c.hidden = false
    and e.hidden = false
  order by c.created_at asc;
$$;


-- ============================================================================
-- 6. 관리자용 함수
-- ============================================================================

-- ---------------------------------------------------------------------------
-- register_admin : 가입 코드가 맞으면, 방금 만든 이메일 계정을 활성화하고 관리자로 등록합니다.
--   화면(admin.html)에서의 순서
--     1) 이메일·비밀번호로 계정 만들기 (Supabase 회원가입)
--     2) 이 함수 호출 → 코드 확인 → 이메일 인증 없이 계정 활성화 → admins 표에 등록
--     3) 로그인
--   가입 코드는 secrets 표에만 있고, 이 함수 안에서만 비교합니다.
-- ---------------------------------------------------------------------------
create or replace function public.register_admin(p_email text, p_code text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_code  text;
  v_uid   uuid;
begin
  select value into v_code from public.secrets where key = 'admin_signup_code';

  -- 코드가 틀리면 1초 쉬었다가 거부합니다. (코드를 마구 대입해 맞히는 시도를 늦춤)
  if v_code is null or btrim(coalesce(p_code, '')) <> v_code then
    perform pg_sleep(1);
    raise exception '관리자 가입 코드가 올바르지 않습니다.';
  end if;

  -- 해당 이메일의 계정을 찾습니다. (익명 계정은 제외)
  select u.id into v_uid
  from auth.users u
  where lower(u.email) = v_email
    and coalesce(u.is_anonymous, false) = false;

  if v_uid is null then
    raise exception '해당 이메일의 계정이 없습니다. 계정 만들기를 먼저 진행해 주세요.';
  end if;

  -- 이메일 인증 메일을 누르지 않아도 바로 로그인할 수 있도록 활성화합니다.
  update auth.users
  set email_confirmed_at = coalesce(email_confirmed_at, now())
  where id = v_uid;

  insert into public.admins (user_id, email)
  values (v_uid, v_email)
  on conflict (user_id) do update set email = excluded.email;

  return json_build_object('ok', true, 'email', v_email);
end;
$$;

-- ---------------------------------------------------------------------------
-- remove_admin : 다른 교사의 관리자 권한을 해제합니다. 본인은 해제할 수 없습니다.
--   (로그인 계정 자체는 남아 있고, 관리자 화면에만 들어올 수 없게 됩니다.)
-- ---------------------------------------------------------------------------
create or replace function public.remove_admin(p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if not public.is_admin() then
    raise exception '관리자만 사용할 수 있습니다.';
  end if;

  if v_email = lower(coalesce(auth.jwt() ->> 'email', '')) then
    raise exception '본인의 관리자 권한은 해제할 수 없습니다.';
  end if;

  delete from public.admins where email = v_email;

  if not found then
    raise exception '해당 이메일의 관리자가 없습니다.';
  end if;
end;
$$;


-- ============================================================================
-- 7. 함수 실행 권한
-- ============================================================================
--  함수도 기본으로는 누구나 실행할 수 있게 만들어지므로, 전부 거둔 뒤 필요한 역할에만 줍니다.
-- ============================================================================
revoke all on function
  public.normalize_school(text),
  public.mask_name(text),
  public.is_admin(),
  public.current_student_id(),
  public.voting_is_open(),
  public.claim_student(text, text, text, boolean),
  public.toggle_like(uuid),
  public.add_comment(uuid, text),
  public.delete_my_comment(uuid),
  public.get_entry_stats(),
  public.get_comments(uuid),
  public.register_admin(text, text),
  public.remove_admin(text)
from public, anon, authenticated;

-- 보안 정책 안에서 쓰이므로 방문자도 실행할 수 있어야 합니다. (결과는 본인에 대한 참/거짓뿐)
grant execute on function public.is_admin() to anon, authenticated;

-- 갤러리는 로그인 전에도 볼 수 있으므로 조회 함수는 누구나
grant execute on function public.get_entry_stats()  to anon, authenticated;
grant execute on function public.get_comments(uuid) to anon, authenticated;

-- 학생의 쓰기 함수는 로그인(익명 로그인 포함)한 사용자만
grant execute on function public.claim_student(text, text, text, boolean) to authenticated;
grant execute on function public.toggle_like(uuid)                       to authenticated;
grant execute on function public.add_comment(uuid, text)                 to authenticated;
grant execute on function public.delete_my_comment(uuid)                 to authenticated;

-- 관리자 가입은 로그인 전 화면에서도 호출하므로 누구나 (가입 코드가 문지기 역할)
grant execute on function public.register_admin(text, text) to anon, authenticated;
grant execute on function public.remove_admin(text)         to authenticated;

-- normalize_school, mask_name, current_student_id, voting_is_open 은
-- 위 함수들 안에서만 쓰이므로 브라우저에는 실행 권한을 주지 않습니다.


-- ============================================================================
-- 8. Storage : 작품 이미지 보관함
-- ============================================================================
--  entries 버킷 : 공개(public) 버킷이라 이미지 주소를 알면 누구나 볼 수 있습니다.
--                 올리기·바꾸기·지우기는 관리자만 가능합니다.
--                 파일 1개당 최대 10MB, 이미지 형식만 허용합니다.
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'entries', 'entries', true, 10485760,
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do update
set public             = excluded.public,
    file_size_limit    = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists entries_storage_admin_read   on storage.objects;
drop policy if exists entries_storage_admin_insert on storage.objects;
drop policy if exists entries_storage_admin_update on storage.objects;
drop policy if exists entries_storage_admin_delete on storage.objects;

-- 파일 목록 조회·삭제를 하려면 읽기 정책도 필요합니다. (이미지 "보기"는 공개 주소로 따로 됩니다)
create policy entries_storage_admin_read on storage.objects
  for select to authenticated
  using (bucket_id = 'entries' and public.is_admin());

create policy entries_storage_admin_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'entries' and public.is_admin());

create policy entries_storage_admin_update on storage.objects
  for update to authenticated
  using (bucket_id = 'entries' and public.is_admin())
  with check (bucket_id = 'entries' and public.is_admin());

create policy entries_storage_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'entries' and public.is_admin());


-- ============================================================================
-- 9. 마무리 : API 서버가 새로 만든 표·함수를 바로 알아차리게 합니다.
-- ============================================================================
notify pgrst, 'reload schema';
