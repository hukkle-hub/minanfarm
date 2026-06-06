-- =====================================================================
-- 한우 올인원 — 약품 재고 스키마 (Supabase / PostgreSQL)
-- 앞서 만든 cattle·diary·ai_cases 스키마에 더해지는 부분.
-- 약품 등록(사진 포함) · 수량 · 유통기한 알림 · 웹 약품정보 캐시
-- =====================================================================

-- 약품 마스터 (성분·종류·처방대상·휴약기간 등 약 자체 정보)
create table medications (
  id            uuid primary key default gen_random_uuid(),
  farm_id       uuid not null references farms(id),
  name          text not null,            -- 상품명
  ingredient    text,                     -- 성분
  type          text,                     -- 항생제/백신/구충/보조 등
  rx_required   boolean default false,    -- 처방대상 여부(수의사 처방제)
  withdrawal_days int,                     -- 휴약기간(일) — 라벨/식약처 기준
  drug_info_id  uuid references drug_info(id),
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  deleted_at    timestamptz
);

-- 약품 로트(입고 단위): 같은 약이라도 유통기한/수량이 다른 묶음을 따로 관리
create table med_lots (
  id            uuid primary key default gen_random_uuid(),
  medication_id uuid not null references medications(id),
  farm_id       uuid not null references farms(id),
  lot_no        text,
  quantity      numeric not null default 0,  -- 보유 수량
  unit          text default '개',
  expiry_date   date,                        -- 유통기한
  registered_via text default 'manual',      -- manual / photo
  photo_url     text,                        -- 사진 등록 시 원본
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  deleted_at    timestamptz
);
create index med_lots_farm_exp on med_lots (farm_id, expiry_date);

-- 웹에서 수집한 약품 정보 캐시 (효능·부작용·휴약기간·출처)
create table drug_info (
  id            uuid primary key default gen_random_uuid(),
  query         text not null,            -- 검색 약명/성분
  efficacy      text,                     -- 효능
  side_effects  text,                     -- 부작용/후유증
  withdrawal    text,                     -- 휴약기간 안내
  prescription  boolean,                  -- 처방대상 여부
  source_url    text,
  fetched_at    timestamptz default now()
);
create unique index drug_info_query on drug_info (query);

-- 유통기한 임박/만료 알림용 뷰 (D-60 이하)
create view v_expiring_lots as
  select l.*, m.name, m.rx_required,
         (l.expiry_date - current_date) as days_left
  from med_lots l
  join medications m on m.id = l.medication_id
  where l.deleted_at is null
    and l.expiry_date is not null
    and l.expiry_date - current_date <= 60
  order by l.expiry_date asc;

-- RLS: 농장 격리
alter table medications enable row level security;
alter table med_lots    enable row level security;
create policy med_sel  on medications for select using (farm_id = auth.uid()::uuid);
create policy med_wr   on medications for all    using (farm_id = auth.uid()::uuid) with check (farm_id = auth.uid()::uuid);
create policy lot_sel  on med_lots    for select using (farm_id = auth.uid()::uuid);
create policy lot_wr   on med_lots    for all    using (farm_id = auth.uid()::uuid) with check (farm_id = auth.uid()::uuid);
-- drug_info 는 공용 캐시(읽기 공개, 쓰기는 서버 함수로만)
alter table drug_info enable row level security;
create policy di_sel on drug_info for select using (true);

-- 매일 새벽 cron(예: pg_cron)에서 v_expiring_lots 를 조회해
-- 해당 농장에 유통기한 임박 Web Push / 로컬알림 예약을 트리거.
