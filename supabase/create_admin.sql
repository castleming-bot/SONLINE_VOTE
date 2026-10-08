-- ============================================================================
--  첫 관리자(교사) 계정을 SQL 로 미리 만들어 두기 (create_admin.sql)
-- ============================================================================
--  언제 쓰나요?
--    admin.html 의 "관리자 계정 만들기"(가입 코드 사용)로도 계정을 만들 수 있습니다.
--    이 파일은 사이트를 열기 전에 첫 관리자 계정을 미리 넣어 두고 싶을 때 씁니다.
--
--  사용법
--    1) schema.sql 을 먼저 실행해 둡니다.
--    2) 아래 두 줄의 이메일과 비밀번호를 본인 것으로 바꿉니다. (비밀번호는 6자 이상)
--    3) Supabase 대시보드 → SQL Editor 에 전체를 붙여넣고 Run.
--
--  [주의] 비밀번호를 적은 채로 이 파일을 저장하거나 GitHub 에 올리지 마세요.
--         SQL Editor 창 안에서만 바꿔 넣고 실행하면 됩니다.
--         비밀번호는 암호화(bcrypt)되어 저장되므로 DB에서도 원래 글자는 볼 수 없습니다.
--
--  여러 번 실행해도 안전합니다. 이미 있는 이메일이면 비밀번호는 바꾸지 않고
--  활성화 + 관리자 등록만 합니다.
-- ============================================================================
do $$
declare
  v_email    text := 'teacher@example.com';   -- ← 여기에 이메일
  v_password text := '여기에_비밀번호';        -- ← 여기에 비밀번호 (6자 이상)
  v_uid      uuid;
begin
  v_email := lower(btrim(v_email));

  if v_email = 'teacher@example.com' or v_password = '여기에_비밀번호' then
    raise exception '이메일과 비밀번호를 먼저 바꿔 주세요.';
  end if;
  if char_length(v_password) < 6 then
    raise exception '비밀번호는 6자 이상이어야 합니다.';
  end if;

  select id into v_uid from auth.users where lower(email) = v_email;

  if v_uid is null then
    -- 1) 로그인 계정 만들기 (이메일 인증이 끝난 상태로)
    v_uid := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change, email_change_token_new
    ) values (
      '00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated',
      v_email, extensions.crypt(v_password, extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
      '', '', '', ''
    );

    -- 2) 이메일 로그인 방식 연결 (이 줄이 있어야 이메일+비밀번호로 로그인됩니다)
    insert into auth.identities (
      id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), v_uid, v_uid::text, 'email',
      jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true, 'phone_verified', false),
      now(), now(), now()
    );
  else
    -- 이미 있는 계정이면 활성화만 합니다.
    update auth.users
    set email_confirmed_at = coalesce(email_confirmed_at, now())
    where id = v_uid;
  end if;

  -- 3) 관리자 명단에 등록
  insert into public.admins (user_id, email)
  values (v_uid, v_email)
  on conflict (user_id) do update set email = excluded.email;

  raise notice '관리자 계정 준비 완료: %', v_email;
end $$;
