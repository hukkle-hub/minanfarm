/**
 * 한우 올인원 — AI 도구 모듈
 *  1) 약품 사진 인식(약명·유통기한·수량 OCR+AI)
 *  2) 웹 약품정보 수집(효능·부작용·휴약기간)
 *  3) 보유 약품 기반 상황 판단(안전장치 포함)
 *  4) 음성 대화(웹 Speech / 네이티브)
 *  ⚠ 동물약 안전수칙: 휴약기간 준수, 처방대상은 수의사 처방, 용량·투여경로 준수.
 */

/* ===== 1) 약품 사진 인식 (서버 Edge Function 권장) ===== */
// 상자/라벨 사진 → Vision 모델이 약명·유통기한·수량을 구조화해 반환.
// (정밀 OCR이 필요하면 ML Kit/Google Vision으로 텍스트 추출 후 LLM이 필드 매핑)
export interface MedScan { name?: string; ingredient?: string; expiry?: string; qty?: number; }

export async function scanMedPhoto(apiKey: string, imageBase64: string): Promise<MedScan> {
  const prompt =
    "이 동물약 상자/라벨 사진에서 다음을 JSON으로만 추출해라. " +
    "{name, ingredient, expiry(YYYY-MM-DD), qty(number)}. " +
    "유통기한은 '유효기간/EXP/사용기한' 표기를 찾아 변환. 없으면 null.";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [
          { text: prompt },
          { inline_data: { mime_type: "image/jpeg", data: imageBase64 } },
        ]}],
        generationConfig: { responseMimeType: "application/json" },
      })
    });
  const json = await res.json();
  try { return JSON.parse(json.candidates[0].content.parts[0].text); }
  catch { return {}; }
}

/* ===== 2) 웹 약품정보 수집 (서버에서 수행 후 drug_info 캐시) ===== */
export interface DrugInfo {
  query: string; efficacy?: string; sideEffects?: string;
  withdrawal?: string; prescription?: boolean; sourceUrl?: string;
}
// 신뢰 출처 우선: 농림축산검역본부 동물용의약품정보, 식약처, 제품 라벨.
// (검색 API 또는 해당 사이트 스크래핑 → LLM 요약 → 캐시 저장)
export async function collectDrugInfo(db: any, name: string): Promise<DrugInfo> {
  // 1) 캐시 확인
  const { data: cached } = await db.from("drug_info").select("*").eq("query", name).maybeSingle();
  if (cached) return { query: name, efficacy: cached.efficacy, sideEffects: cached.side_effects,
    withdrawal: cached.withdrawal, prescription: cached.prescription, sourceUrl: cached.source_url };
  // 2) 없으면 웹 수집(서버 함수) → 요약 → 캐시
  const info = await fetchDrugFromWeb(name);     // 구현체: 검색+요약
  await db.from("drug_info").insert({
    query: name, efficacy: info.efficacy, side_effects: info.sideEffects,
    withdrawal: info.withdrawal, prescription: info.prescription, source_url: info.sourceUrl });
  return info;
}
async function fetchDrugFromWeb(name: string): Promise<DrugInfo> {
  // 서버 측에서 검역본부/식약처 동물용의약품 정보 등을 조회·요약하도록 구현
  return { query: name, efficacy: "(웹 수집)", sideEffects: "(웹 수집)",
    withdrawal: "제품 라벨/식약처 기준 확인", prescription: true,
    sourceUrl: "https://www.qia.go.kr" };
}

/* ===== 3) 보유 약품 기반 상황 판단 (안전장치 내장) ===== */
export interface OwnedMed { name: string; type: string; rxRequired: boolean; withdrawalDays?: number; qty: number; expiry?: string; }
export interface Advice { text: string; suggested: string[]; warnings: string[]; needsVet: boolean; }

export function adviseFromInventory(symptom: string, inventory: OwnedMed[]): Advice {
  const warnings: string[] = [];
  const suggested: string[] = [];
  let text = "";

  if (/설사/.test(symptom)) {
    const fluid = inventory.find((m) => /전해질|수액/.test(m.name));
    if (fluid) suggested.push(`${fluid.name} (탈수 보정 우선)`);
    text = "설사는 탈수 보정이 1순위입니다. 색이 흰색·혈변이면 세균성 가능성이 있어 항생제가 필요할 수 있습니다.";
    const abx = inventory.find((m) => m.type === "항생제");
    if (abx) suggested.push(`${abx.name} (세균성 의심 시 — 수의사 확인)`);
  } else {
    text = "증상을 더 구체적으로 알려주시면 보유 약품 중 적용 가능한 것을 안내합니다.";
  }

  // 안전장치: 처방대상·휴약기간 경고는 항상
  for (const m of inventory) {
    if (m.rxRequired) warnings.push(`${m.name}: 처방대상 — 수의사 처방·확인 필요`);
    if (m.withdrawalDays) warnings.push(`${m.name}: 휴약기간 ${m.withdrawalDays}일 — 출하 전 준수`);
    if (m.expiry && new Date(m.expiry) < new Date()) warnings.push(`${m.name}: 유통기한 만료 — 사용 금지`);
  }
  const needsVet = /혈변|흰색|기립|고열/.test(symptom) || inventory.some((m) => m.rxRequired);
  return { text, suggested, warnings, needsVet };
}

/* ===== 4) 음성 대화 ===== */
// 웹(PWA): Web Speech API
export function listenWeb(onText: (t: string) => void) {
  const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SR) return false;
  const rec = new SR(); rec.lang = "ko-KR"; rec.interimResults = false;
  rec.onresult = (e: any) => onText(e.results[0][0].transcript);
  rec.start();
  return true;
}
export function speak(text: string) {
  const u = new SpeechSynthesisUtterance(text); u.lang = "ko-KR"; speechSynthesis.speak(u);
}
// 네이티브(Capacitor): @capacitor-community/speech-recognition (오프라인·정확도↑)
//   import { SpeechRecognition } from "@capacitor-community/speech-recognition";
//   await SpeechRecognition.requestPermissions();
//   await SpeechRecognition.start({ language: "ko-KR", popup: false });

/* --- 사용 흐름 ---
 * 1) 사진 등록: scanMedPhoto → 확인 → med_lots 저장(수량·유통기한)
 * 2) 유통기한: v_expiring_lots → 알림 예약(hanwoo-notify)
 * 3) 음성/텍스트 질문 → adviseFromInventory(보유약 기준) + collectDrugInfo(웹 정보)
 *    → 휴약기간·처방·만료 경고와 함께 답변, 위험하면 수의사 연결
 */
