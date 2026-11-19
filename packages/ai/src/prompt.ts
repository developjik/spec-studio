import {
  GRAPH_LINK_ENDS,
  GRAPH_LINK_LABEL,
  NODE_TYPE_LABEL,
  type AiProposalMode,
  type Project,
} from '@spec-studio/protocol';

/**
 * The prompt is the contract read aloud.
 *
 * Everything the model needs to answer is written here: the pins with their
 * numbers, what the graph already holds, the document's block ids, and the
 * exact JSON shape. Nothing is left to a tool-call schema, because a custom
 * endpoint is allowed to be a small local model that supports neither tools
 * nor strict JSON mode — so the shape is also validated after the answer.
 */

const LINK_TABLE = (Object.keys(GRAPH_LINK_ENDS) as Array<keyof typeof GRAPH_LINK_ENDS>)
  .map((type) => {
    const ends = GRAPH_LINK_ENDS[type];
    return `- ${type} (${GRAPH_LINK_LABEL[type]}): ${ends.src.join('|')} → ${ends.dst.join('|')}`;
  })
  .join('\n');

export function buildSystemPrompt(mode: AiProposalMode): string {
  const common = [
    '너는 한국어 화면설계서(spec-studio)의 제안 엔진이다.',
    '너는 문서를 직접 고치지 않는다. 사람이 채택 여부를 결정할 초안만 만든다.',
    '항상 JSON 객체 하나만 출력한다. 설명, 인사, 마크다운 코드펜스, 주석을 붙이지 않는다.',
    '모든 텍스트는 한국어로, 문장은 짧고 단정하게 쓴다.',
    '핀 번호는 주어진 목록에 있는 것만 인용한다. 없는 번호를 지어내면 그 초안은 버려진다.',
  ];
  if (mode === 'graph') {
    common.push(
      '노드 타입은 req(요구사항), policy(정책), contract(계약), qa(QA) 네 가지뿐이다.',
      '링크는 아래 표에 있는 타입과 방향만 쓴다. 링크의 양 끝은 item:<key> 또는 pin:<번호> 로 쓴다.',
      LINK_TABLE,
      '이미 그래프에 있는 제목은 다시 제안하지 않는다. 핀에서 실제로 읽히는 것만 만든다.',
    );
  } else {
    common.push(
      '문서의 기존 문단을 고치는 제안만 만든다. 새 문단을 만들 수 없다.',
      '문단 id는 주어진 목록에 있는 것만 쓴다.',
      '인용 줄([핀] ...)은 쓰지 않는다. 본문만 쓰면 시스템이 인용을 붙인다.',
    );
  }
  return common.join('\n');
}

function pinLine(pin: Project['pins'][number]): string {
  const body = pin.body.trim().replace(/\s+/g, ' ');
  return `#${pin.number} [${pin.type}] ${pin.title}${body === '' ? '' : ` — ${body.slice(0, 240)}`}`;
}

export function buildGraphPrompt(project: Project): string {
  const screen = project.screen;
  const lines: string[] = [];
  lines.push(`화면: ${screen === null ? '(없음)' : `${screen.title} (${screen.code})`}`);
  lines.push('');
  lines.push(`핀 ${project.pins.length}개:`);
  for (const pin of [...project.pins].sort((a, b) => a.number - b.number)) {
    lines.push(pinLine(pin));
  }
  lines.push('');
  if (project.graph.nodes.length === 0) {
    lines.push('그래프: 아직 비어 있다.');
  } else {
    lines.push(`그래프에 이미 있는 객체 ${project.graph.nodes.length}개 (제목을 다시 만들지 않는다):`);
    for (const node of project.graph.nodes.slice(0, 40)) {
      lines.push(`- ${node.type}(${NODE_TYPE_LABEL[node.type]}): ${node.title}`);
    }
  }
  lines.push('');
  lines.push('다음 JSON 하나로만 답한다:');
  lines.push(
    JSON.stringify({
      summary: '한 줄 요약 (사람이 결정 카드에서 읽는다)',
      nodes: [
        {
          key: 'n1',
          type: 'policy',
          title: '15자 안팎의 객체 제목',
          body: '핀에서 읽은 내용을 정책/요구사항/계약/QA 문장으로 정리한다.',
          pins: [1],
        },
      ],
      links: [{ type: 'governs', src: 'item:n1', dst: 'pin:1' }],
    }),
  );
  lines.push('');
  lines.push('규칙: nodes는 1~12개, links는 만들 수 있는 것만. body는 20~400자. qa의 body에는 "사전조건:"과 "기대 결과:"를 넣는다.');
  return lines.join('\n');
}

export function buildDocPrompt(project: Project, docId?: string): string {
  const doc = project.doc;
  if (doc === null || (docId !== undefined && doc.id !== docId)) {
    return '';
  }
  const lines: string[] = [];
  lines.push(`문서: ${doc.title}`);
  lines.push('');
  lines.push('문단 (id · 타입 · 본문):');
  for (const block of doc.blocks.slice(0, 60)) {
    const prose = block.text.split('\n\n[핀]')[0] ?? block.text;
    lines.push(`- ${block.id} · ${block.type} · ${prose.replace(/\s+/g, ' ').slice(0, 400)}`);
  }
  if (doc.blocks.length === 0) lines.push('- (문단이 없다. 고칠 수 있는 것이 없으므로 빈 patches를 내지 말고 요약만 만들지 말 것)');
  lines.push('');
  lines.push(`화면 핀 ${project.pins.length}개:`);
  for (const pin of [...project.pins].sort((a, b) => a.number - b.number)) {
    lines.push(pinLine(pin));
  }
  lines.push('');
  lines.push('다음 JSON 하나로만 답한다:');
  lines.push(
    JSON.stringify({
      summary: '한 줄 요약',
      patches: [
        {
          blockId: 'B_aaaaaaaaaaaa',
          text: '그 문단의 새 본문 (인용 줄 없이)',
          pins: [1],
        },
      ],
    }),
  );
  lines.push('');
  lines.push('규칙: patches는 1~6개. 기존 문단 id만. 바뀌는 문단만 넣는다. text는 20~600자.');
  return lines.join('\n');
}

/** A one-line call that only has to prove the endpoint answers. */
export function buildProbePrompt(): { system: string; prompt: string } {
  return {
    system: 'You are a health check. Reply with exactly this JSON and nothing else: {"ok":true}',
    prompt: 'reply',
  };
}
