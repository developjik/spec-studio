/**
 * The one-click sample screen: a plausible order-detail page, drawn as an
 * inline SVG so the repository carries no binary asset and the screen renders
 * identically offline.
 */
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800" font-family="Noto Sans KR, Apple SD Gothic Neo, Malgun Gothic, sans-serif">
  <rect width="1200" height="800" fill="#ffffff"/>

  <rect x="0" y="0" width="1200" height="64" fill="#ffffff"/>
  <line x1="0" y1="64" x2="1200" y2="64" stroke="#e5e8ed"/>
  <rect x="40" y="22" width="20" height="20" rx="4" fill="none" stroke="#0f1216" stroke-width="1.5"/>
  <line x1="45" y1="27" x2="55" y2="27" stroke="#0f1216" stroke-width="1.5"/>
  <text x="72" y="38" font-size="14" font-weight="700" letter-spacing="1.8" fill="#0f1216">MARCHE</text>
  <text x="240" y="38" font-size="13" font-weight="600" fill="#0f1216">홈</text>
  <text x="300" y="38" font-size="13" fill="#3f4650">기획전</text>
  <text x="376" y="38" font-size="13" fill="#3f4650">베스트</text>
  <text x="456" y="38" font-size="13" fill="#3f4650">신상품</text>
  <rect x="780" y="18" width="240" height="28" rx="6" fill="#f7f8fa" stroke="#e5e8ed"/>
  <circle cx="798" cy="32" r="4.5" fill="none" stroke="#838b97" stroke-width="1.4"/>
  <line x1="801.5" y1="35.5" x2="805" y2="39" stroke="#838b97" stroke-width="1.4"/>
  <text x="814" y="36" font-size="11.5" fill="#838b97">상품 검색</text>
  <text x="1040" y="37" font-size="11.5" fill="#3f4650">장바구니</text>
  <text x="1100" y="37" font-size="11.5" fill="#3f4650">마이페이지</text>

  <rect x="0" y="65" width="1200" height="40" fill="#fafbfc"/>
  <line x1="0" y1="105" x2="1200" y2="105" stroke="#eef0f3"/>
  <text x="40" y="90" font-size="11.5" fill="#6b7280">마이페이지</text>
  <text x="104" y="90" font-size="11.5" fill="#b6bdc7">/</text>
  <text x="116" y="90" font-size="11.5" fill="#6b7280">주문 내역</text>
  <text x="180" y="90" font-size="11.5" fill="#b6bdc7">/</text>
  <text x="192" y="90" font-size="11.5" font-weight="600" fill="#0f1216">주문 상세</text>

  <text x="40" y="154" font-size="26" font-weight="700" letter-spacing="-0.4" fill="#0f1216">주문 상세</text>
  <text x="1160" y="151" text-anchor="end" font-size="10.5" font-family="monospace" fill="#6b7280">주문번호 2026-1119-0042 · 2026.11.19 09:12</text>

  <rect x="40" y="178" width="1120" height="84" rx="8" fill="#eef2fc" stroke="#c8d5f5"/>
  <text x="64" y="212" font-size="16" font-weight="700" fill="#2453c9">배송 준비 중</text>
  <text x="64" y="236" font-size="12" fill="#3f4650">11월 20일(목) 출고 예정 · CJ대한통운 1234-5678-90</text>
  <rect x="1000" y="202" width="136" height="36" rx="6" fill="#ffffff" stroke="#c8d5f5"/>
  <text x="1068" y="225" text-anchor="middle" font-size="12" font-weight="600" fill="#2453c9">배송 조회</text>

  <rect x="40" y="286" width="720" height="196" rx="8" fill="#ffffff" stroke="#e5e8ed"/>
  <rect x="64" y="310" width="88" height="88" rx="6" fill="#f2f3f5"/>
  <rect x="92" y="342" width="32" height="24" rx="2" fill="none" stroke="#c2c8d2" stroke-width="1.3"/>
  <line x1="92" y1="350" x2="124" y2="350" stroke="#c2c8d2" stroke-width="1.3"/>
  <line x1="108" y1="350" x2="108" y2="366" stroke="#c2c8d2" stroke-width="1.3"/>
  <text x="176" y="332" font-size="15.5" font-weight="600" fill="#0f1216">데일리 코튼 셔츠</text>
  <text x="176" y="356" font-size="12" fill="#6b7280">화이트 · L · 1개</text>
  <text x="176" y="384" font-size="14" font-weight="600" fill="#0f1216">39,000원</text>
  <rect x="612" y="308" width="120" height="24" rx="12" fill="#f7f8fa" stroke="#e5e8ed"/>
  <text x="672" y="324" text-anchor="middle" font-size="10.5" fill="#3f4650">배송 준비 중</text>
  <line x1="64" y1="422" x2="736" y2="422" stroke="#eef0f3"/>
  <rect x="64" y="436" width="96" height="32" rx="6" fill="#ffffff" stroke="#d3d9e2"/>
  <text x="112" y="456" text-anchor="middle" font-size="12" fill="#0f1216">취소 요청</text>
  <rect x="172" y="436" width="108" height="32" rx="6" fill="#ffffff" stroke="#d3d9e2"/>
  <text x="226" y="456" text-anchor="middle" font-size="12" fill="#0f1216">교환 · 반품</text>

  <rect x="784" y="286" width="376" height="196" rx="8" fill="#ffffff" stroke="#e5e8ed"/>
  <text x="808" y="318" font-size="13" font-weight="600" fill="#0f1216">결제 정보</text>
  <text x="808" y="350" font-size="12" fill="#6b7280">상품금액</text>
  <text x="1136" y="350" text-anchor="end" font-size="12" fill="#3f4650">39,000원</text>
  <text x="808" y="376" font-size="12" fill="#6b7280">배송비</text>
  <text x="1136" y="376" text-anchor="end" font-size="12" fill="#3f4650">3,000원</text>
  <text x="808" y="402" font-size="12" fill="#6b7280">할인</text>
  <text x="1136" y="402" text-anchor="end" font-size="12" fill="#3f4650">-2,000원</text>
  <line x1="808" y1="416" x2="1136" y2="416" stroke="#eef0f3"/>
  <text x="808" y="446" font-size="13" font-weight="700" fill="#0f1216">결제금액</text>
  <text x="1136" y="448" text-anchor="end" font-size="15" font-weight="700" fill="#0f1216">40,000원</text>

  <rect x="40" y="506" width="720" height="218" rx="8" fill="#ffffff" stroke="#e5e8ed"/>
  <text x="64" y="538" font-size="13" font-weight="600" fill="#0f1216">배송 정보</text>
  <text x="64" y="572" font-size="11.5" fill="#838b97">받는 사람</text>
  <text x="152" y="572" font-size="12.5" fill="#0f1216">정인권</text>
  <text x="64" y="598" font-size="11.5" fill="#838b97">연락처</text>
  <text x="152" y="598" font-size="12.5" fill="#0f1216">010-0000-0000</text>
  <text x="64" y="624" font-size="11.5" fill="#838b97">주소</text>
  <text x="152" y="624" font-size="12.5" fill="#0f1216">서울시 광진구 능동로 000, 000동 000호</text>
  <text x="64" y="650" font-size="11.5" fill="#838b97">배송 메시지</text>
  <text x="152" y="650" font-size="12.5" fill="#0f1216">문 앞에 놓아주세요</text>
  <text x="64" y="686" font-size="11.5" fill="#838b97">배송 방법</text>
  <text x="152" y="686" font-size="12.5" fill="#0f1216">일반 배송 · 11월 20일 출고</text>

  <rect x="784" y="506" width="376" height="218" rx="8" fill="#ffffff" stroke="#e5e8ed"/>
  <text x="808" y="538" font-size="13" font-weight="600" fill="#0f1216">주문 진행 상태</text>
  <line x1="820" y1="580" x2="1084" y2="580" stroke="#e5e8ed" stroke-width="2"/>
  <line x1="820" y1="580" x2="908" y2="580" stroke="#2453c9" stroke-width="2"/>
  <circle cx="820" cy="580" r="6" fill="#2453c9"/>
  <circle cx="908" cy="580" r="6" fill="#ffffff" stroke="#2453c9" stroke-width="2"/>
  <circle cx="996" cy="580" r="5" fill="#d3d9e2"/>
  <circle cx="1084" cy="580" r="5" fill="#d3d9e2"/>
  <text x="820" y="606" text-anchor="middle" font-size="10.5" fill="#0f1216">결제 완료</text>
  <text x="908" y="606" text-anchor="middle" font-size="10.5" font-weight="600" fill="#2453c9">상품 준비</text>
  <text x="996" y="606" text-anchor="middle" font-size="10.5" fill="#838b97">배송 시작</text>
  <text x="1084" y="606" text-anchor="middle" font-size="10.5" fill="#838b97">배송 완료</text>
  <text x="820" y="622" text-anchor="middle" font-size="9.5" fill="#b6bdc7">11.19</text>
  <text x="908" y="622" text-anchor="middle" font-size="9.5" fill="#b6bdc7">11.19</text>
  <text x="996" y="622" text-anchor="middle" font-size="9.5" fill="#b6bdc7">11.20 예정</text>
  <text x="1084" y="622" text-anchor="middle" font-size="9.5" fill="#b6bdc7">11.22 예정</text>
  <text x="808" y="664" font-size="10.5" fill="#6b7280">배송이 시작되면 취소·변경이 제한됩니다.</text>

  <line x1="0" y1="758" x2="1200" y2="758" stroke="#e5e8ed"/>
  <text x="40" y="784" font-size="11.5" fill="#6b7280">도움이 필요하세요? 1:1 문의 · 반품 안내</text>
  <text x="1160" y="784" text-anchor="end" font-size="9.5" letter-spacing="1.2" fill="#b6bdc7">MARCHE — ORDER DETAIL</text>
</svg>`;

export const SAMPLE_IMAGE = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}`;
export const SAMPLE_WIDTH = 1200;
export const SAMPLE_HEIGHT = 800;
export const SAMPLE_TITLE = '주문 상세';
export const SAMPLE_CODE = 'SCR-110';
