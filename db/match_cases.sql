-- =====================================================================
-- 한우 올인원 — AI 사례 학습용 벡터DB 스키마 (PostgreSQL + pgvector)
-- 용도: AI가 "발전"하는 핵심 저장소. 증상·교배·질문 사례를 임베딩으로 쌓아
--       비슷한 상황을 검색(RAG)하고, 피드백으로 정확도를 보정한다.
-- =====================================================================

create extension if not exists vector;      -- pgvector (Supabase 기본 제공)

-- ---------------------------------------------------------------------
-- 사례 테이블
--   embedding 차원은 임베딩 모델에 맞춘다.
--   예) Gemini text-embedding-004 / 768, OpenAI text-embedding-3-small / 1536
-- ---------------------------------------------------------------------
create table ai_cases (
  id          uuid primary key default gen_random_uuid(),
  farm_id     uuid not null references farms(id),
  type        text not null check (type in ('diagnosis','breeding','qa')),
  input       text not null,            -- 증상/질문 원문
  context     jsonb,                    -- 개체 월령·임신주차·등급 등
  outcome     text,                     -- 실제 결과(완치/등급/분만 등) = 학습 라벨
  helpful     boolean,                  -- 사용자 피드백(도움됨)
  shareable   boolean default false,    -- 익명 지역공유 동의 여부
  embedding   vector(768),              -- 검색용 임베딩
  created_at  timestamptz default now()
);

-- 근사 최근접 검색 인덱스 (코사인). 데이터가 많아지면 lists 값 조정.
create index ai_cases_embedding_idx
  on ai_cases using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index ai_cases_farm_idx on ai_cases (farm_id, type, created_at desc);

-- ---------------------------------------------------------------------
-- 유사사례 검색 함수
--   내 농장 사례 + (동의된) 익명 지역사례에서 의미가 비슷한 케이스를 반환.
--   helpful=true(검증된 사례)에 가중치를 줘 신뢰도 높은 사례를 우선 노출.
-- ---------------------------------------------------------------------
create or replace function match_cases(
  query_embedding vector(768),
  p_farm_id       uuid,
  match_count     int   default 4,
  min_similarity  float default 0.70
)
returns table (
  id         uuid,
  input      text,
  outcome    text,
  helpful    boolean,
  similarity float,
  score      float            -- 유사도 + 검증 가중치
)
language sql stable
as $$
  select
    c.id,
    c.input,
    c.outcome,
    c.helpful,
    1 - (c.embedding <=> query_embedding)                              as similarity,
    (1 - (c.embedding <=> query_embedding))
      + case when c.helpful then 0.05 else 0 end                       as score
  from ai_cases c
  where (c.farm_id = p_farm_id or c.shareable = true)
    and c.embedding is not null
    and 1 - (c.embedding <=> query_embedding) > min_similarity
  order by score desc
  limit match_count;
$$;

-- ---------------------------------------------------------------------
-- 행수준 보안(RLS): 농장 격리. 내 농장 사례 + 공유동의된 사례만 읽기.
-- ---------------------------------------------------------------------
alter table ai_cases enable row level security;

create policy ai_cases_select on ai_cases
  for select using (
    farm_id = auth.uid()::uuid          -- (예시) 사용자=농장 매핑에 맞게 조정
    or shareable = true
  );

create policy ai_cases_write on ai_cases
  for insert with check (farm_id = auth.uid()::uuid);

-- ---------------------------------------------------------------------
-- 사용 예 (앱 → RPC)
--   const { data } = await db.rpc('match_cases', {
--     query_embedding: vec,        -- 질문 임베딩(768차원)
--     p_farm_id: farmId,
--     match_count: 4
--   });
-- 반환된 input/outcome 를 LLM 프롬프트의 "참고 자료"로 넣어 RAG 수행.
-- ---------------------------------------------------------------------
