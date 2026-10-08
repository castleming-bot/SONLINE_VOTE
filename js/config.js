// ============================================================================
//  config.js - Supabase 연결 정보
// ============================================================================
//  이 파일의 두 값만 바꾸면 다른 Supabase 프로젝트로 옮길 수 있습니다.
//  값 위치: Supabase 대시보드 → Project Settings → API
//
//  [중요] 여기에 넣는 키는 반드시 anon(publishable) key 여야 합니다.
//    - anon key 는 공개되어도 괜찮도록 설계된 키입니다.
//      실제 보호는 DB의 보안 정책(RLS)과 함수가 담당합니다. (supabase/schema.sql 참고)
//    - service_role / secret key 는 모든 보안 정책을 무시하는 만능 열쇠이므로
//      절대로 이 파일이나 다른 코드에 넣으면 안 됩니다.
// ============================================================================
window.APP_CONFIG = {
  // 프로젝트 주소 (끝에 /rest/v1/ 은 붙이지 않습니다)
  SUPABASE_URL: 'https://uwsazwldhjylrvyfwplp.supabase.co',

  // anon(publishable) key
  SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV3c2F6d2xkaGp5bHJ2eWZ3cGxwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0MjMwODksImV4cCI6MjEwNjk5OTA4OX0.ZKvyMCxmYU6TbVqJSOF3kqM5bT3Ah1uD4Dbl_V904_Y',

  // 작품 이미지를 보관하는 Storage 버킷 이름 (schema.sql 에서 만든 이름과 같아야 함)
  BUCKET: 'entries',
};
