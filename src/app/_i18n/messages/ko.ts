/**
 * Every string the console shows a person, in Korean.
 *
 * Typed as `Messages` rather than inferred, which is what makes a key missing
 * here a compile error instead of a blank spot on a page. `en.ts` says why the
 * catalogue is TypeScript, and why the product nouns below are still English.
 *
 * The register is polite-formal (`~합니다` / `~하세요`), which is what a Korean
 * product UI speaks to the person using it — not the plain style this
 * repository's prose documents are written in.
 */
import type { Messages } from "./en";

export const ko: Messages = {
  "locale.label": "언어",
  "locale.change": "언어 변경",

  "theme.label": "테마",
  "theme.current": "테마: {name}",
  "theme.system": "시스템",
  "theme.light": "라이트",
  "theme.dark": "다크",

  "chrome.tagline": "함께 일하는 에이전트",
  "chrome.navLabel": "워크스페이스 내비게이션",
  "chrome.openProjects": "Projects 열기",
  "chrome.status": "워크스페이스 온라인 · v{version}",
  "nav.group.workspace": "워크스페이스",
  "nav.group.intelligence": "인텔리전스",
  "nav.group.system": "시스템",
  "nav.overview": "개요",
  "nav.projects": "Projects",
  "nav.chats": "Chats",
  "nav.artifacts": "Artifacts",
  "nav.profile": "프로필",
  "nav.plugins": "Plugins",
  "nav.skills": "Skills",
  "nav.tools": "Tools",
  "nav.agents": "Agents",
  "nav.members": "멤버",
  "nav.audit": "감사 로그",
  "nav.models": "Models",
  "nav.settings": "설정",

  "auth.signIn": "Google 계정으로 로그인",
  "auth.signOut": "로그아웃",
  "login.title": "로그인이 필요합니다",
  "login.product": "AgentDure — 프롬프트·에이전트·비용을 관리하는 사내 LLM 플랫폼입니다.",
  "login.domains": "이 배포가 허용한 도메인의 Google 계정으로 로그인하세요.",

  "home.eyebrow": "버전 · 배포 · 실행",
  "home.headline": "에이전트를 한 번 만들면,",
  "home.headlineAccent": " 어디서든 호출할 수 있습니다.",
  "home.lede":
    "프롬프트나 에이전트를 프로젝트로 작성하고, 버전으로 다듬고, 하나를 배포하세요. 그다음엔 콘솔에서도, OpenAI 호환 API 로도, Slack·웹훅·다른 에이전트에서도 호출할 수 있습니다. 모든 실행은 귀속되고, 비용이 매겨지고, 한도 안에서 돕니다.",
  "home.signInHint": "이 배포가 허용한 도메인의 Google 계정이 필요합니다.",
  "home.proof.engine": "하나의 엔진",
  "home.proof.engineNote": "모든 모델, 모든 창구",
  "home.proof.traces": "실시간 트레이스",
  "home.proof.tracesNote": "모든 에이전트 전환",
  "home.proof.cost": "정확한 비용",
  "home.proof.costNote": "모든 호출을 귀속",
  "home.streamLabel": "에이전트 실행 스트림 예시",
  "home.streamCaption": "agent run · text/event-stream",
  "home.streamLive": "live",
  "home.agentOnline": "● 에이전트 온라인",
  "home.coverage": "AgentDure 가 다루는 범위",
  "home.domain.projects": "Projects 와 버전",
  "home.domain.projectsBody":
    "프롬프트·에이전트·이미지 프로젝트를 변경 불가능한 버전으로 작성합니다. 하나를 배포하면 호출자는 그 버전을 고정하거나 포인터를 따라갑니다.",
  "home.domain.agent": "에이전트 루프",
  "home.domain.agentBody":
    "턴 한도, 필요할 때 불러오는 Skill, 서브에이전트 전환을 갖춘 멀티턴 도구 루프. 처음부터 끝까지 스트리밍됩니다.",
  "home.domain.mcp": "MCP 도구",
  "home.domain.mcpBody":
    "서버를 한 번 등록하면 버전이 이를 바인딩하고, 도구를 추리고, 헤더를 덮어씁니다. 프로젝트별 OAuth 를 지원하며 시크릿은 암호화해 저장합니다.",
  "home.domain.skills": "Skills",
  "home.domain.skillsBody":
    "마크다운으로 쓴 행동 팩. 모델에게 목록만 보여주고 모델이 요청할 때만 불러옵니다.",
  "home.domain.plugins": "Agent Plugins",
  "home.domain.pluginsBody":
    "Skill 과 MCP 서버를 하나의 플러그인 저장소에서 동기화합니다. 저장소가 선언한 모든 이름의 기준입니다.",
  "home.domain.chats": "Chats",
  "home.domain.chatsBody":
    "어떤 에이전트 프로젝트와도 대화할 수 있습니다. 답변은 스트리밍되고, 도구 호출은 대화 안에 남으며, 실행은 탭이 닫혀도 계속됩니다.",
  "home.domain.images": "이미지",
  "home.domain.imagesBody":
    "프롬프트로 그리거나 편집합니다. 프로젝트 타입으로도, 에이전트 빌트인으로도, 이미지 서브에이전트로도 가능하며, 편집은 실행이 지나온 어떤 이미지든 지정할 수 있습니다.",
  "home.domain.surfaces": "Slack · A2A · 웹훅",
  "home.domain.surfacesBody":
    "프로젝트별 Slack 봇, 양방향 A2A, 웹훅과 스케줄 트리거 — 모든 진입점이 같은 엔진으로 돕니다.",
  "home.domain.cost": "비용과 가드",
  "home.domain.costBody":
    "모든 호출에 모델 레지스트리 기준 단가를 매겨 프로젝트별·호출자별·일자별로 집계합니다. 일간·월간 한도에 닿으면 경고하고, 넘으면 거절합니다.",
  "home.dureName": "두레",
  "home.dure":
    "— 이웃이 힘을 모아 혼자서는 끝낼 수 없는 일을 해내던 마을 공동 노동입니다. 여기의 에이전트도 같은 방식으로 일합니다.",
  "home.product": "프롬프트·에이전트·비용을 관리하는 사내 LLM 플랫폼입니다.",
};
