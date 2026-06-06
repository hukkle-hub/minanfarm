# 한우 올인원 — Capacitor 네이티브 패키징 가이드

PWA(`index.html` 등)를 그대로 감싸 **안드로이드/iOS 네이티브 앱**으로 만들고,
카메라(약 사진)·로컬 알림(앱 꺼져도 동작)·음성인식 같은 네이티브 기능을 붙인다.

## 1. 설치 & 초기화
```bash
npm i @capacitor/core @capacitor/cli
npx cap init "한우 올인원" "kr.hanwoo.allinone" --web-dir=.
npm i @capacitor/android @capacitor/ios
npx cap add android
npx cap add ios
```
`--web-dir`는 index.html 등 웹 자원이 있는 폴더로 지정.

## 2. capacitor.config.ts
```ts
import type { CapacitorConfig } from "@capacitor/cli";
const config: CapacitorConfig = {
  appId: "kr.hanwoo.allinone",
  appName: "한우 올인원",
  webDir: ".",
  backgroundColor: "#1F4D2E",
  plugins: {
    LocalNotifications: { smallIcon: "ic_stat_icon", iconColor: "#1F4D2E" },
  },
};
export default config;
```

## 3. 네이티브 플러그인
```bash
npm i @capacitor/camera             # 약 상자 사진 촬영
npm i @capacitor/local-notifications # 앱 꺼져도 주차별·유통기한 알림
npm i @capacitor-community/speech-recognition  # 한국어 음성 대화
```

### 카메라 (약 사진 등록)
```ts
import { Camera, CameraResultType } from "@capacitor/camera";
const photo = await Camera.getPhoto({ resultType: CameraResultType.Base64, quality: 80 });
// photo.base64String → scanMedPhoto() 로 약명·유통기한 인식
```

### 로컬 알림 (앱 종료 상태에서도 정시 알림)
```ts
import { LocalNotifications } from "@capacitor/local-notifications";
await LocalNotifications.requestPermissions();
await LocalNotifications.schedule({ notifications: [{
  id: 1, title: "002 임신감정(채혈)",
  body: "6주차 · 채혈 예정", schedule: { at: new Date("2026-06-20T08:00:00"), allowWhileIdle: true },
}]});
// hanwoo-notify.ts 의 buildAlarms() 결과를 그대로 schedule
```

### 음성 인식 (오프라인·정확도↑)
```ts
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
await SpeechRecognition.requestPermissions();
const { matches } = await SpeechRecognition.start({ language: "ko-KR", popup: false, partialResults: false });
// matches[0] → adviseFromInventory()
```

## 4. 권한 (네이티브)
- Android `AndroidManifest.xml`: CAMERA, POST_NOTIFICATIONS, RECORD_AUDIO,
  (문자 자동저장 쓸 경우) RECEIVE_SMS/READ_SMS — Play 정책 심사 필요
- iOS `Info.plist`: NSCameraUsageDescription, NSMicrophoneUsageDescription,
  NSSpeechRecognitionUsageDescription

## 5. 빌드 & 스토어 배포
```bash
npx cap sync          # 웹 변경 반영
npx cap open android  # Android Studio → 서명 후 Play Console 업로드
npx cap open ios      # Xcode → Archive → App Store Connect
```

## 왜 네이티브로 감싸나
- **로컬 알림**: PWA만으로는 앱 종료 상태의 예약 알림이 불안정. 네이티브는 OS가 정시 보장.
- **카메라/음성**: 권한·성능이 안정적.
- **오프라인**: 축사 환경에서 더 견고.
PWA 단계로 먼저 검증하고, 위 기능이 중요해지면 Capacitor로 감싸 스토어에 올리는 흐름을 권장.
