/**
 * 한우 올인원 — 시세 오픈API 연동 + 공판장 정산문자 파싱 모듈
 * --------------------------------------------------------------
 * 서버(예: Supabase Edge Function / Node)에서 실행하세요.
 * 인증키는 절대 앱에 넣지 말고 서버 환경변수에 보관합니다.
 *
 * 포함:
 *  1) KAMIS 시세 클라이언트 (한우 가격)
 *  2) 축산물품질평가원(축평원) 경락/등급 연동 (구조 예시)
 *  3) 가축시장(우시장) 시세 수집 안내
 *  4) 공판장별 정산문자 파싱기 (정규식, 프로필 기반)
 */

/* =========================================================
 * 1) KAMIS 시세 클라이언트
 * 인증키 발급: https://www.kamis.or.kr/customer/reference/openapi_write.do
 *  - p_cert_key : 발급 인증키
 *  - p_cert_id  : KAMIS 계정 아이디
 *  - action     : dailyPriceByCategoryList / periodProductList 등
 *  - p_returntype : json
 * 부류코드(p_item_category_code): 축산물 = 500
 *  ※ 품목/품종 코드(p_item_code, p_kind_code)는 KAMIS 코드표에서 최종 확인
 * ========================================================= */

const KAMIS_BASE = "https://www.kamis.or.kr/service/price/xml.do";

interface KamisAuth { certKey: string; certId: string; }

interface KamisDailyOpts {
  date?: string;          // YYYY-MM-DD (기본: 오늘)
  cls?: "01" | "02";      // 01 소매, 02 도매
  categoryCode?: string;  // 기본 500 (축산물)
  convertKg?: "Y" | "N";
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 일별 부류별 가격 (축산물 부류=500) */
export async function kamisDailyByCategory(auth: KamisAuth, opts: KamisDailyOpts = {}) {
  const qs = new URLSearchParams({
    action: "dailyPriceByCategoryList",
    p_cert_key: auth.certKey,
    p_cert_id: auth.certId,
    p_returntype: "json",
    p_product_cls_code: opts.cls ?? "01",
    p_item_category_code: opts.categoryCode ?? "500",
    p_regday: opts.date ?? today(),
    p_convert_kg_yn: opts.convertKg ?? "N",
  });

  const res = await fetch(`${KAMIS_BASE}?${qs.toString()}`);
  const json = await res.json();
  return normalizeKamis(json);
}

/** KAMIS 응답은 data가 객체/배열로 들쭉날쭉 → 안전하게 정규화 */
function normalizeKamis(json: any) {
  const data = json?.data;
  if (!data) return [];
  // 에러 코드 방어
  if (data.error_code && data.error_code !== "000") {
    throw new Error(`KAMIS error ${data.error_code}`);
  }
  const items = Array.isArray(data.item) ? data.item : data.item ? [data.item] : [];
  return items.map((it: any) => ({
    item: it.item_name,          // 품목 (예: 소)
    kind: it.kind_name,          // 품종 (예: 한우 등심)
    rank: it.rank,               // 등급
    unit: it.unit,               // 단위
    price: toNumber(it.dpr1),    // 당일 가격
    prevDay: toNumber(it.dpr2),
    direction: it.direction,     // 등락
  }));
}

function toNumber(s: any): number | undefined {
  if (s == null) return undefined;
  const n = Number(String(s).replace(/[,\s원]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/* =========================================================
 * 2) 축산물품질평가원(축평원) 경락/등급 — 한우 거세우 지육 경락가
 * 한우 '지육 kg당 경락가'의 1차 출처는 KAMIS가 아니라 축평원입니다.
 * 공공데이터포털의 축평원 API(data.ekape.or.kr 기반)를 활용신청 후 사용.
 * 아래는 호출 구조 예시 — 정확한 path/파라미터/필드명은 활용신청 명세에서 확정.
 * ========================================================= */

const EKAPE_GRADE_BASE =
  "https://data.ekape.or.kr/openapi-data/service/user/grade/confirm/list";

export async function ekapeAuctionPrice(serviceKey: string, dateYmd: string) {
  const qs = new URLSearchParams({
    serviceKey,           // 공공데이터포털 발급키
    issueDate: dateYmd,   // YYYYMMDD (명세 확인)
    _type: "json",
  });
  const res = await fetch(`${EKAPE_GRADE_BASE}?${qs.toString()}`);
  const json = await res.json();
  const items = json?.response?.body?.items?.item ?? [];
  // 거세우(steer) 평균 지육 경락가 등으로 가공
  return items;
}

/* =========================================================
 * 3) 가축시장(우시장) 송아지 시세
 * 공개 OpenAPI가 없습니다. 권장 방식:
 *  - 농협 축산정보센터 / 축협 스마트가축시장 페이지를 서버에서 주기 수집(크롤링)
 *  - 또는 농협과 데이터 제휴
 *  - 수집값을 자체 DB(market_prices)에 캐시 → 앱에 제공
 * 아래는 캐시 조회 인터페이스 예시.
 * ========================================================= */

export interface MarketPrice {
  marketCode: string;   // 예: gimje
  marketName: string;   // 김제 가축시장
  date: string;
  bullCalf?: number;     // 수송아지 평균 낙찰가(원)
  cowCalf?: number;      // 암송아지 평균 낙찰가(원)
  topPrice?: number;     // 최고가
  count?: number;        // 거래두수
  source: string;        // 출처(농협 축산정보센터 등)
}

export async function getMarketPrice(db: any, marketCode: string): Promise<MarketPrice | null> {
  // 서버가 미리 수집해 둔 최신 캐시를 반환
  const { data } = await db
    .from("market_prices")
    .select("*")
    .eq("market_code", marketCode)
    .order("date", { ascending: false })
    .limit(1)
    .single();
  return data ?? null;
}

/* =========================================================
 * 4) 공판장별 정산문자 파싱기
 * 공판장/도축장마다 문자 양식이 다르므로, '프로필'을 추가하는 방식으로 확장.
 * 새 공판장 양식이 들어오면 profiles 배열에 항목만 추가하면 됩니다.
 *
 * ⚠ 아래 정규식은 대표 양식 기준 예시입니다.
 *   실제 운영 시 각 공판장의 실문자 샘플로 반드시 검증·보정하세요.
 * ========================================================= */

export interface ParsedSettlement {
  source: string;          // 인식된 공판장
  kind: "출하정산" | "송아지구매" | "거래";
  earTag?: string;         // 개체식별번호(이력번호) 12자리
  carcassWeight?: number;  // 도체중 kg
  meatGrade?: string;      // 육질등급 1++/1+/1/2/3
  yieldGrade?: string;     // 육량등급 A/B/C
  unitPrice?: number;      // 낙찰단가 원/kg
  amount?: number;         // 정산액/낙찰액 원
  confidence: number;      // 인식 신뢰도 0~1
  raw: string;
}

interface Patterns {
  earTag?: RegExp;
  carcassWeight?: RegExp;
  meatGrade?: RegExp;
  yieldGrade?: RegExp;
  unitPrice?: RegExp;
  amount?: RegExp;
}

interface SourceProfile {
  name: string;
  match: RegExp;     // 발신번호/문구로 공판장 식별
  kind: ParsedSettlement["kind"];
  patterns: Patterns;
}

/** 공판장별 프로필 — 필요한 만큼 계속 추가 */
const profiles: SourceProfile[] = [
  {
    name: "음성축산물공판장",
    match: /음성|농협음성|음성공판/,
    kind: "출하정산",
    patterns: {
      earTag: /(\d{12})/,
      carcassWeight: /도체중\s*([\d.]+)\s*kg/,
      meatGrade: /(?:육질)?\s*(1\+\+|1\+|[123])\s*등?급?/,
      yieldGrade: /(?:육량)?\s*([ABC])\s*등?급?/,
      unitPrice: /낙찰단가\s*([\d,]+)\s*원?/,
      amount: /정산(?:예정)?(?:액)?\s*([\d,]+)\s*원?/,
    },
  },
  {
    name: "부천축산물공판장",
    match: /부천/,
    kind: "출하정산",
    patterns: {
      earTag: /(\d{12})/,
      carcassWeight: /지육\s*([\d.]+)\s*kg/,
      meatGrade: /(1\+\+|1\+|[123])\s*등급/,
      yieldGrade: /([ABC])\s*등급/,
      unitPrice: /단가\s*([\d,]+)/,
      amount: /(?:금액|정산)\s*([\d,]+)/,
    },
  },
  {
    name: "나주축산물공판장",
    match: /나주/,
    kind: "출하정산",
    patterns: {
      earTag: /(\d{12})/,
      carcassWeight: /([\d.]+)\s*kg/,
      meatGrade: /(1\+\+|1\+|[123])등급/,
      yieldGrade: /([ABC])등급/,
      unitPrice: /([\d,]+)\s*원\/?kg/,
      amount: /([\d,]{6,})\s*원/,
    },
  },
  {
    name: "가축시장(송아지)",
    match: /가축시장|우시장|축협.*경매/,
    kind: "송아지구매",
    patterns: {
      amount: /낙찰\s*([\d,]+)\s*원?/,
      earTag: /(\d{12})/,
    },
  },
];

/** 어느 프로필에도 안 맞을 때의 일반 추출기 */
const generic: SourceProfile = {
  name: "일반(자동)",
  match: /.*/,
  kind: "거래",
  patterns: {
    earTag: /(\d{12})/,
    carcassWeight: /([\d.]{2,5})\s*kg/,
    meatGrade: /(1\+\+|1\+|[123])\s*등급/,
    yieldGrade: /([ABC])\s*등급/,
    unitPrice: /([\d,]{4,6})\s*원\s*\/?\s*kg/,
    amount: /([\d,]{6,})\s*원/,
  },
};

function pick(text: string, re?: RegExp): string | undefined {
  if (!re) return undefined;
  const m = text.match(re);
  return m ? m[m.length - 1] : undefined; // 마지막 캡처 그룹
}

/**
 * 정산/낙찰 문자 1건을 구조화.
 * @param text 수신 문자 본문
 * @param sender 발신번호/발신처(선택) — 프로필 매칭 정확도 향상
 */
export function parseSettlement(text: string, sender = ""): ParsedSettlement {
  const haystack = `${sender} ${text}`;
  const p = profiles.find((pr) => pr.match.test(haystack)) ?? generic;

  const result: ParsedSettlement = {
    source: p.name,
    kind: p.kind,
    earTag: pick(text, p.patterns.earTag),
    carcassWeight: toNumber(pick(text, p.patterns.carcassWeight)),
    meatGrade: pick(text, p.patterns.meatGrade),
    yieldGrade: pick(text, p.patterns.yieldGrade),
    unitPrice: toNumber(pick(text, p.patterns.unitPrice)),
    amount: toNumber(pick(text, p.patterns.amount)),
    confidence: 0,
    raw: text,
  };

  // 신뢰도: 채워진 핵심 필드 비율
  const keys = ["earTag", "carcassWeight", "meatGrade", "unitPrice", "amount"] as const;
  const filled = keys.filter((k) => result[k] != null).length;
  result.confidence = Math.round((filled / keys.length) * 100) / 100;
  return result;
}

/**
 * 파싱 결과를 개체 출하기록에 저장.
 * 이력번호로 개체를 찾고, 신뢰도 낮으면 사용자 확인 대기 큐로.
 */
export async function saveSettlement(db: any, farmId: string, parsed: ParsedSettlement) {
  if (parsed.confidence < 0.6 || !parsed.earTag) {
    await db.from("settlement_inbox").insert({ farm_id: farmId, ...parsed, status: "needs_review" });
    return { status: "needs_review", parsed };
  }
  const { data: cattle } = await db
    .from("cattle").select("id").eq("farm_id", farmId).eq("ear_tag", parsed.earTag).single();
  if (!cattle) {
    await db.from("settlement_inbox").insert({ farm_id: farmId, ...parsed, status: "no_match" });
    return { status: "no_match", parsed };
  }
  await db.from("shipment_records").insert({
    cattle_id: cattle.id,
    carcass_weight: parsed.carcassWeight,
    meat_grade: parsed.meatGrade,
    yield_grade: parsed.yieldGrade,
    price: parsed.amount,
    shipped_at: today(),
  });
  return { status: "saved", parsed };
}

/* =========================================================
 * 5) 모바일 단의 문자 수신 (플랫폼 차이)
 *  - Android: BroadcastReceiver(android.provider.Telephony.SMS_RECEIVED) +
 *    READ_SMS/RECEIVE_SMS 권한. 지정 발신번호만 필터 → parseSettlement.
 *    ※ Google Play SMS 권한 정책 심사 필요(기본 SMS 앱이 아니면 제한적).
 *  - iOS: 문자 직접 읽기 불가. 공유시트(Share Extension)로 전달받거나,
 *    사용자가 붙여넣기 / 스크린샷 OCR(Vision)로 처리.
 * 어느 경우든 텍스트만 확보되면 parseSettlement 로직은 동일하게 재사용.
 * ========================================================= */

/* --- 사용 예시 ---
const sms = "[정산안내] 002123456789 도체중 458kg 육질1++ 육량A 낙찰단가 21,800원/kg 정산예정액 9,984,400원";
console.log(parseSettlement(sms, "음성축산물공판장"));
// → { source:"음성축산물공판장", kind:"출하정산", earTag:"002123456789",
//     carcassWeight:458, meatGrade:"1++", yieldGrade:"A",
//     unitPrice:21800, amount:9984400, confidence:1, raw:"..." }
*/
