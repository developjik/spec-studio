# @spec-studio/desktop — Electron 셸 (D1)

브라우저 + `pnpm daemon` 두 터미널 없이, 앱 하나로 쓰기 위한 데스크톱 셸.

- **런타임 의존성 0** — 메인/프리로드는 esbuild CJS 번들 2개뿐.
- **데몬은 `utilityProcess.fork`로 사이드카 실행** (`apps/daemon/dist/daemon.mjs`, 기존 번들 그대로). HTTP 프로토콜 무변경이라 브라우저 모드와 공존.
- **랜덤 포트 + 1회성 세션 토큰** — 부팅마다 포트를 새로 할당하고 32바이트 토큰을 발급. 데몬은 `x-daemon-token` 없는 요청을 401로 거부 (토큰은 로그·디스크에 0회 기록).
- **렌더러는 `app://` 프로토콜로 `apps/web` 빌드 산출을 그대로 로드** — `file://`의 null origin 문제 없음. 웹 빌드는 `window.specstudio` 유무만 보고 데스크톱/브라우저를 구분 (웹 코드 변경은 `apps/web/src/model/daemon.ts` 한 곳).
- **데이터**: `<userData>/spec-studio.db` — 재시작해도 유지.

## 실행

```bash
# 전제: 워크스페이스 루트에서
pnpm install
pnpm daemon:build          # apps/daemon/dist/daemon.mjs
pnpm --filter @spec-studio/web build   # apps/web/dist
pnpm desktop               # = electron . (apps/desktop)
```

## 검증

```bash
pnpm desktop:smoke
# 3단계 부팅(create → verify → window): 프로젝트 생성 → 재시작 후 유지 확인 →
# 실제 렌더러에서 preload 브리지·CORS·토큰 경로로 /api/health 호출까지 검증.
# window 단계에서 실제 윈도우가 몇 초 떠 있습니다.
```

## 패키징 (D4에서 서명·자동업데이트 추가 예정)

```bash
pnpm daemon:build && pnpm --filter @spec-studio/web build
pnpm desktop:package:dir   # → apps/desktop/release/mac/arm64/spec-studio.app (미서명)
```

## D2/D3를 위한 자리

- `src/main/daemon.ts`의 세션 토큰 발급부 → D2의 safeStorage 자격증명, D3의 구독 토큰 갱신이 같은 구역에 붙습니다.
- `src/preload/index.ts`의 `getDaemonInfo()` → 설정 UI가 필요로 하는 최소 노출만 유지 (R-6: 웹 분기 1곳).
