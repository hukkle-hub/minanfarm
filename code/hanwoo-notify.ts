/**
 * 한우 올인원 — 백그라운드 알림 스케줄러
 * ==========================================
 * "앱이 꺼져 있어도" 주차별 백신·채혈·수정확인 알림을 띄우는 두 경로.
 *
 *  경로 A) 웹(PWA): Web Push
 *    - 브라우저가 닫혀 있어도, 서버가 예약 시각에 푸시를 보내면 SW가 알림 표시.
 *    - 단점: 알림을 "서버가" 보내야 함(기기 단독 예약 불가). 서버 cron 필요.
 *
 *  경로 B) 네이티브(Capacitor로 감싼 앱): Local Notifications
 *    - 기기에 직접 예약 → 앱이 완전히 종료돼도 OS가 정시에 알림. 서버 불필요.
 *    - 농가용으로 가장 확실(오프라인에서도 동작). 권장.
 *
 * 권장: PWA로 배포하되, 확실한 알람이 필요하면 Capacitor로 패키징해 경로 B 사용.
 */

/* ============ 경로 A: Web Push 구독 + 서버 예약 ============ */

const VAPID_PUBLIC = "<서버 VAPID 공개키>";

export async function enableWebPush(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return null;

  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC),
  });
  // 구독 정보를 서버에 저장 → 서버가 예약 시각에 푸시 발송
  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sub),
  });
  return sub;
}

/** 주차별 케어 일정을 서버에 예약 (서버가 cron으로 정시 푸시) */
export async function scheduleCareReminder(opts: {
  cattleId: string; title: string; body: string; fireAt: string; // ISO
}) {
  await fetch("/api/push/schedule", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
}

function urlBase64ToUint8Array(base64: string) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/* ============ 경로 B: Capacitor Local Notifications (네이티브) ============ */
// 설치: npm i @capacitor/local-notifications
// import { LocalNotifications } from "@capacitor/local-notifications";

/**
 * 개체의 임신주차/월령에 맞춰 주차별 알림을 '기기에' 미리 예약.
 * 앱을 완전히 종료해도 OS가 정시에 울린다.
 */
export async function scheduleLocalCareAlarms(LocalNotifications: any, items: CareAlarm[]) {
  await LocalNotifications.requestPermissions();
  await LocalNotifications.schedule({
    notifications: items.map((it, i) => ({
      id: it.id ?? i + 1,
      title: it.title,            // 예: "002 송아지설사 백신 1차"
      body: it.body,              // 예: "분만 5–6주 전 · 2㎖ 근육·피하"
      schedule: { at: new Date(it.fireAt), allowWhileIdle: true }, // 절전 중에도
      extra: { cattleId: it.cattleId, action: it.action },
    })),
  });
}

export interface CareAlarm {
  id?: number;
  cattleId: string;
  title: string;
  body: string;
  fireAt: string;     // ISO 시각
  action: "vaccine" | "blood" | "ai_check" | "observe" | "etc";
}

/* ============ 주차별 일정 → 알림 시각 계산 ============ */
/**
 * 프로토콜(주차별 항목) + 개체 기준일(수정일/출생일)로 알림 시각 산출.
 * 임신: 기준 = 수정일, 주차 → 수정일 + week*7
 * 송아지: 기준 = 출생일, 주차 → 출생일 + week*7
 */
export function buildAlarms(
  cattleId: string,
  baseDateISO: string,
  protocol: { week: number; action: CareAlarm["action"]; label: string }[],
  hour = 8
): CareAlarm[] {
  const base = new Date(baseDateISO);
  return protocol.map((p) => {
    const d = new Date(base);
    d.setDate(d.getDate() + p.week * 7);
    d.setHours(hour, 0, 0, 0);
    return {
      cattleId,
      title: `${cattleId} ${p.label}`,
      body: `${p.week}주차 · ${labelKo(p.action)}`,
      fireAt: d.toISOString(),
      action: p.action,
    };
  });
}

function labelKo(a: CareAlarm["action"]) {
  return { vaccine: "예방주사", blood: "채혈", ai_check: "수정확인", observe: "관찰", etc: "관리" }[a];
}

/* --- 사용 예 ---
// 임신우 002: 수정일 기준 주차별 알림을 기기에 예약(네이티브)
const alarms = buildAlarms("002", "2025-11-09", [
  { week: 6,  action: "ai_check", label: "임신감정(채혈)" },
  { week: 35, action: "vaccine",  label: "송아지설사 백신 1차" },
  { week: 37, action: "vaccine",  label: "백신 추가·분만방 준비" },
]);
await scheduleLocalCareAlarms(LocalNotifications, alarms);
*/
