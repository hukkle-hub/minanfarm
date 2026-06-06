/**
 * 한우 올인원 — Supabase 데이터 계층
 * 실제 데이터 저장(클라우드) + 오프라인 우선 동기화.
 * 설치: npm i @supabase/supabase-js
 */
import { createClient, SupabaseClient } from "@supabase/supabase-js";

// URL/anon key는 Supabase 프로젝트 설정에서. (anon key는 공개돼도 RLS가 보호)
export const supabase: SupabaseClient = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

/* ===== 인증 ===== */
export const signIn = (email: string, password: string) =>
  supabase.auth.signInWithPassword({ email, password });
export const signOut = () => supabase.auth.signOut();
export const currentUser = async () => (await supabase.auth.getUser()).data.user;

/* ===== 일지 ===== */
export async function addDiary(farmId: string, e: {
  cattle_id?: string; date: string; category: string; text: string;
}) {
  return supabase.from("diary").insert({ farm_id: farmId, ...e });
}
export async function listDiary(farmId: string, cattleId?: string) {
  let q = supabase.from("diary").select("*").eq("farm_id", farmId)
    .is("deleted_at", null).order("date", { ascending: false });
  if (cattleId) q = q.eq("cattle_id", cattleId);
  return q;
}

/* ===== 약품 재고 ===== */
export async function addMedication(farmId: string, m: {
  name: string; ingredient?: string; type?: string;
  rx_required?: boolean; withdrawal_days?: number;
}) {
  return supabase.from("medications").insert({ farm_id: farmId, ...m }).select().single();
}
export async function addLot(farmId: string, lot: {
  medication_id: string; quantity: number; unit?: string;
  expiry_date?: string; registered_via?: "manual" | "photo"; photo_url?: string;
}) {
  return supabase.from("med_lots").insert({ farm_id: farmId, ...lot });
}
/** 유통기한 임박 로트 (D-day 이하) */
export async function expiringLots(_farmId: string, withinDays = 60) {
  return supabase.from("v_expiring_lots").select("*").lte("days_left", withinDays);
}
/** 수량 차감(사용 기록 시) */
export async function consumeLot(lotId: string, used: number) {
  const { data } = await supabase.from("med_lots").select("quantity").eq("id", lotId).single();
  const left = Math.max(0, (data?.quantity ?? 0) - used);
  return supabase.from("med_lots").update({ quantity: left, updated_at: new Date().toISOString() }).eq("id", lotId);
}

/* ===== 실시간 구독 (다기기 동기화) ===== */
export function subscribeFarm(farmId: string, onChange: () => void) {
  return supabase
    .channel(`farm-${farmId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "med_lots", filter: `farm_id=eq.${farmId}` }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "diary", filter: `farm_id=eq.${farmId}` }, onChange)
    .subscribe();
}

/* ===== 오프라인 우선: 아웃박스 패턴 =====
 * 축사에서 통신이 끊기면 로컬(IndexedDB/SQLite)에 쌓고,
 * 연결되면 순서대로 서버에 반영. (단말이 적은 농가라 LWW로 충분) */
export interface Outbox { id: string; table: string; row: any; op: "insert" | "update" | "delete"; }

export async function flushOutbox(getQueue: () => Promise<Outbox[]>, clear: (id: string) => Promise<void>) {
  if (!navigator.onLine) return;
  for (const item of await getQueue()) {
    try {
      if (item.op === "insert") await supabase.from(item.table).insert(item.row);
      else if (item.op === "update") await supabase.from(item.table).update(item.row).eq("id", item.row.id);
      else await supabase.from(item.table).update({ deleted_at: new Date().toISOString() }).eq("id", item.row.id);
      await clear(item.id);
    } catch { /* 다음 온라인 때 재시도 */ }
  }
}
// 연결 복구 시 자동 동기화
window.addEventListener("online", () => {/* flushOutbox(...) 호출 */});
