/**
 * 한우 올인원 — AI 엔진 (독립적·발전 가능한 학습형 어시스턴트)
 * ============================================================
 * 설계 원칙
 *  1) 독립성   : 외부 AI 없이도 동작(규칙+지식베이스+계산). 인터넷 끊겨도 OK.
 *  2) 발전(학습): 모델을 매번 재학습하는 게 아니라, "사례를 쌓고(RAG) +
 *                 피드백으로 가중치를 보정"하며 점점 정확해짐. 충분히 쌓이면
 *                 데이터를 내보내 소형 모델 파인튜닝(선택).
 *  3) 무료/유료 : Provider 추상화로 갈아끼움. 사용자가 "무료만" 켜면 유료 호출 차단.
 *  4) 판단/방향 : 농장 데이터 + 지식베이스 + 유사사례를 합쳐 신뢰도와 함께 제시.
 *                 위험하거나 불확실하면 수의사/전문가로 넘김.
 */

/* ========== 공통 타입 ========== */
export type Tier = "free_local" | "free_cloud" | "paid";

export interface AskInput {
  question: string;
  imageBase64?: string;            // 사진 진단용(설사 등)
  cattleContext?: Record<string, any>; // 해당 개체 월령·백신·임신주차 등
}

export interface AIAnswer {
  text: string;
  recommendation?: string;         // 방향 제시
  confidence: number;              // 0~1
  needsVet: boolean;               // 전문가 연결 권장
  source: string;                  // 어떤 provider/지식이 답했는지
}

/* ========== Provider 추상화 ========== */
export interface AIProvider {
  name: string;
  tier: Tier;
  offline: boolean;
  ask(input: AskInput, kb: string[]): Promise<AIAnswer>;
}

/* ---------- (A) 무료·오프라인: 규칙 + 지식베이스 + 계산 ----------
 * API 비용 0, 오프라인 동작, 데이터 외부 유출 0(프라이버시 최상).
 * 설사 색깔 규칙·백신 스케줄·손익 계산 등 결정적(deterministic) 로직 담당. */
export class LocalRuleProvider implements AIProvider {
  name = "내장 규칙엔진"; tier: Tier = "free_local"; offline = true;
  async ask(input: AskInput, kb: string[]): Promise<AIAnswer> {
    const q = input.question;
    // 예: 설사 색 규칙 매칭
    if (/흰색|회백색|백색/.test(q)) {
      return { text: "흰색 물똥은 생후 1주 이내 대장균 감염일 때가 많고 경과가 빠릅니다.",
        recommendation: "경구 항생제+지사제, 탈수 시 수액·전해질. 혈변·기립불능이면 즉시 수의사.",
        confidence: 0.8, needsVet: true, source: this.name };
    }
    // 매칭 실패 시 지식베이스 스니펫만 반환(LLM 없이도 최소 답변)
    const hit = kb[0];
    return { text: hit ?? "관련 정보를 찾지 못했습니다.",
      confidence: hit ? 0.5 : 0.2, needsVet: false, source: this.name };
  }
}

/* ---------- (B) 무료·클라우드: Gemini 무료 티어 ----------
 * 2026년 기준 Flash/Flash-Lite가 무료(신용카드 불필요).
 * ⚠ 무료 티어는 입력 데이터가 모델 학습에 쓰일 수 있음 → 민감정보 마스킹 필수. */
export class GeminiProvider implements AIProvider {
  name; tier: Tier; offline = false;
  constructor(private apiKey: string, private model = "gemini-2.5-flash-lite", paid = false) {
    this.tier = paid ? "paid" : "free_cloud";
    this.name = `Gemini(${model})`;
  }
  async ask(input: AskInput, kb: string[]): Promise<AIAnswer> {
    // 무료 티어면 식별정보 마스킹 후 전송
    const safeCtx = this.tier === "free_cloud" ? maskSensitive(input.cattleContext) : input.cattleContext;
    const parts: any[] = [{ text: buildPrompt(input.question, kb, safeCtx) }];
    if (input.imageBase64) parts.push({ inline_data: { mime_type: "image/jpeg", data: input.imageBase64 } });

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts }] }) }
    );
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "응답을 받지 못했습니다.";
    return { text, confidence: 0.75, needsVet: /수의사|처방|응급/.test(text), source: this.name };
  }
}

/* ---------- (C) 유료·고급: Claude 등 (정확한 추론, 데이터 미학습) ---------- */
export class ClaudeProvider implements AIProvider {
  name = "Claude"; tier: Tier = "paid"; offline = false;
  constructor(private apiKey: string, private model = "claude-opus-4-8") {}
  async ask(input: AskInput, kb: string[]): Promise<AIAnswer> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: this.model, max_tokens: 1024,
        messages: [{ role: "user", content: buildPrompt(input.question, kb, input.cattleContext) }] }),
    });
    const json = await res.json();
    const text = json?.content?.[0]?.text ?? "";
    return { text, confidence: 0.85, needsVet: /수의사|처방|응급/.test(text), source: this.name };
  }
}

/* ========== 라우터: 무료/유료 정책 + 폴백 ========== */
export interface AISettings {
  freeOnly: boolean;          // true면 유료 provider 절대 호출 안 함
  geminiKey?: string;
  claudeKey?: string;
  preferOffline: boolean;     // 통신 아껴 기기 내 우선
}

export class AIRouter {
  constructor(private settings: AISettings) {}

  private chain(): AIProvider[] {
    const list: AIProvider[] = [new LocalRuleProvider()]; // 항상 1순위 후보(무료·오프라인)
    if (this.settings.geminiKey) list.push(new GeminiProvider(this.settings.geminiKey)); // 무료 클라우드
    if (!this.settings.freeOnly && this.settings.claudeKey)
      list.push(new ClaudeProvider(this.settings.claudeKey)); // 유료(설정 허용 시만)
    if (!this.settings.freeOnly && this.settings.geminiKey)
      list.push(new GeminiProvider(this.settings.geminiKey, "gemini-3.1-pro", true)); // 유료 고급
    return this.settings.preferOffline ? list : list.reverse(); // 정확도 우선이면 고급부터
  }

  async ask(input: AskInput, kb: string[]): Promise<AIAnswer> {
    let last: AIAnswer | null = null;
    for (const p of this.chain()) {
      try {
        const a = await p.ask(input, kb);
        last = a;
        if (a.confidence >= 0.7) return a;  // 충분하면 그대로
      } catch { /* 다음 provider로 폴백(오프라인·rate limit 등) */ }
    }
    return last ?? { text: "지금은 답변할 수 없어요. 잠시 후 다시 시도하세요.",
      confidence: 0, needsVet: false, source: "none" };
  }
}

/* ========== 학습 계층: 사례 축적(RAG) + 피드백 ========== */
/** "발전"의 실체: 모델 재학습이 아니라, 농장 사례를 쌓아 검색 품질을 높이는 것 */
export interface CaseRecord {
  id: string;
  type: "diagnosis" | "breeding" | "qa";
  input: string;            // 증상/질문
  context?: Record<string, any>;
  outcome?: string;         // 실제 결과(완치/등급/분만 등) — 라벨
  embedding?: number[];     // 벡터(검색용)
  helpful?: boolean;        // 사용자 피드백
  createdAt: string;
}

export class LearningStore {
  constructor(private db: any, private embed: (t: string) => Promise<number[]>) {}

  /** 1) 사례 저장: 답변 후 결과를 함께 기록 → 다음에 비슷한 상황 검색에 활용 */
  async record(c: Omit<CaseRecord, "embedding" | "createdAt">) {
    const embedding = await this.embed(c.input + " " + (c.outcome ?? ""));
    await this.db.from("ai_cases").insert({ ...c, embedding, createdAt: new Date().toISOString() });
  }

  /** 2) 유사사례 검색(RAG): 우리 농장 + 지역 익명 사례에서 비슷한 케이스 */
  async retrieve(query: string, k = 4): Promise<string[]> {
    const v = await this.embed(query);
    const { data } = await this.db.rpc("match_cases", { query_embedding: v, match_count: k });
    return (data ?? []).map((r: any) =>
      `유사사례: ${r.input} → 결과: ${r.outcome ?? "기록중"} ${r.helpful ? "(도움됨)" : ""}`);
  }

  /** 3) 피드백 반영: 도움됨/아님 + 실제 결과 → 검색 가중치·신뢰도 보정 */
  async feedback(caseId: string, helpful: boolean, outcome?: string) {
    await this.db.from("ai_cases").update({ helpful, outcome }).eq("id", caseId);
  }

  /** 4) (선택) 충분히 쌓이면 파인튜닝용 데이터셋 내보내기 — '고급 발전' 경로 */
  async exportForFineTune(): Promise<{ prompt: string; completion: string }[]> {
    const { data } = await this.db.from("ai_cases").select("*").eq("helpful", true);
    return (data ?? []).map((c: any) => ({ prompt: c.input, completion: c.outcome ?? "" }));
  }
}

/* ========== 방향 제시/판단 엔진 (전체 결합) ========== */
export class HanwooAssistant {
  constructor(private router: AIRouter, private store: LearningStore) {}

  async advise(input: AskInput): Promise<AIAnswer & { caseId: string }> {
    // 1) 우리 농장·지역 유사사례 + 지식베이스를 함께 근거로
    const similar = await this.store.retrieve(input.question);
    const kb = [...similar, ...KNOWLEDGE_BASE_SNIPPETS(input.question)];
    // 2) 무료/유료 정책에 맞는 provider가 답변
    const answer = await this.router.ask(input, kb);
    // 3) 이번 상호작용을 사례로 기록(결과는 나중에 피드백으로 채움)
    const caseId = crypto.randomUUID();
    await this.store.record({ id: caseId, type: "qa", input: input.question, context: input.cattleContext });
    return { ...answer, caseId };
  }
}

/* ========== 유틸 ========== */
function buildPrompt(q: string, kb: string[], ctx?: Record<string, any>): string {
  return [
    "너는 한우 사양관리 보조다. 진단·처방이 필요하면 수의사 상담을 함께 안내하라.",
    ctx ? `개체 정보: ${JSON.stringify(ctx)}` : "",
    kb.length ? `참고 자료:\n- ${kb.join("\n- ")}` : "",
    `질문: ${q}`,
  ].filter(Boolean).join("\n");
}

/** 무료 클라우드 전송 전, 농장 식별정보 마스킹(데이터가 학습에 쓰일 수 있으므로) */
function maskSensitive(ctx?: Record<string, any>) {
  if (!ctx) return ctx;
  const c = { ...ctx };
  if (c.ear_tag) c.ear_tag = String(c.ear_tag).replace(/\d(?=\d{4})/g, "*"); // 뒤 4자리만
  delete c.farm_name; delete c.owner;
  return c;
}

/** 내장 지식베이스(설계문서 8장)를 질문에 맞춰 검색 — 실제론 임베딩 검색 */
function KNOWLEDGE_BASE_SNIPPETS(q: string): string[] {
  const out: string[] = [];
  if (/설사/.test(q)) out.push("설사 색: 흰색=대장균/위험, 노란색=흔함, 녹색=조사료·살모넬라, 혈변=즉시 수의사");
  if (/백신|접종/.test(q)) out.push("호흡기 백신: 송아지 60–70일 1차·1개월 후 2차 / 송아지설사: 어미 분만 5–6주 전");
  if (/교배|근친|KPN/.test(q)) out.push("근친 회피: 암소 아비 KPN 확인 후 혈연계수 낮은 보증씨수소 선택");
  return out;
}

/* --- 사용 예시 ---
const router = new AIRouter({ freeOnly: true, geminiKey: process.env.GEMINI_KEY, preferOffline: true });
const store  = new LearningStore(db, embedFn);
const ai     = new HanwooAssistant(router, store);

const ans = await ai.advise({ question: "송아지가 흰색 물똥을 싸요", cattleContext: { age_days: 5 } });
// → freeOnly=true 이므로 유료 호출 없이 내장 규칙 + 무료 Gemini로만 답변, 사례로 기록
// 나중에: await store.feedback(ans.caseId, true, "수액 후 3일 만에 회복");
*/
