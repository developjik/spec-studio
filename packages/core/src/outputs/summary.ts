import type { GraphNode, Project } from '@spec-studio/protocol';
import { PIN_TYPE_LABEL } from '@spec-studio/protocol';
import { ungroundedRequirements } from '../graph';
import { pinLabel, sortPinsByNumber } from '../pins';

/**
 * The spec summary sheet of the handoff package (F4): the same state the
 * screen shows, re-organized as one markdown file — 화면·핀 목록·요구사항·
 * 정책·계약·QA 요약. Pure projection like the HTML/CSV siblings: it reads,
 * it never writes, so the file cannot disagree with the project it came from.
 */

function nodesOf(project: Project, type: GraphNode['type']): GraphNode[] {
  return project.graph.nodes.filter((node) => node.type === type);
}

function nodeLine(node: GraphNode): string {
  const body = node.body.trim();
  return `- **${node.title}**${body === '' ? '' : ` — ${body}`}`;
}

export function buildSpecSummaryMd(input: { project: Project; generatedAt: string }): string {
  const { project, generatedAt } = input;
  const { screen } = project;
  const pins = sortPinsByNumber(project.pins);

  const reqs = nodesOf(project, 'req');
  const policies = nodesOf(project, 'policy');
  const contracts = nodesOf(project, 'contract');
  const qas = nodesOf(project, 'qa');
  const ungrounded = new Set(ungroundedRequirements(project).map((node) => node.id));

  const lines: string[] = [
    `# 스펙 요약 — ${project.name}`,
    '',
    `> 생성 ${generatedAt} · Spec Studio 전달 패키지`,
    '',
    '## 화면',
    '',
    screen === null
      ? '- 등록된 화면이 없습니다.'
      : [
          `- 코드: ${screen.code}`,
          `- 제목: ${screen.title}`,
          screen.viewport === null
            ? `- 뷰포트: Figma 연동`
            : `- 뷰포트: ${screen.viewport.width}×${screen.viewport.height}`,
          `- Figma: ${screen.figmaUrl ?? '없음'}`,
        ].join('\n'),
    '',
    `## 핀 (${pins.length})`,
    '',
    pins.length === 0 ? '핀이 없습니다.' : '| 번호 | 유형 | 제목 | 내용 |\n| --- | --- | --- | --- |',
    ...pins.map(
      (pin) =>
        `| ${screen === null ? `#${pin.number}` : pinLabel(screen.code, pin.number)} | ${PIN_TYPE_LABEL[pin.type]} | ${pin.title.replaceAll('|', '\\|')} | ${pin.body.replaceAll('|', '\\|').replaceAll('\n', ' ')} |`,
    ),
    '',
    `## 요구사항 (${reqs.length})`,
    '',
    ...(reqs.length === 0
      ? ['요구사항 노드가 없습니다.']
      : reqs.map((node) => `${nodeLine(node)}${ungrounded.has(node.id) ? '  *(근거 없음)*' : ''}`)),
    '',
    `## 정책 (${policies.length})`,
    '',
    ...(policies.length === 0 ? ['정책 노드가 없습니다.'] : policies.map(nodeLine)),
    '',
    `## 계약 (${contracts.length})`,
    '',
    ...(contracts.length === 0 ? ['계약 노드가 없습니다.'] : contracts.map(nodeLine)),
    '',
    '## QA 요약',
    '',
    `- 검증 항목: ${qas.length}건`,
    `- verifies 링크: ${project.graph.links.filter((link) => link.type === 'verifies').length}건`,
    `- 근거 없는 요구사항: ${ungrounded.size}건`,
    ...(qas.length === 0 ? [] : ['', ...qas.map(nodeLine)]),
    '',
  ];

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}
