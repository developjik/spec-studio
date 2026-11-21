import type { Project } from '@spec-studio/protocol';
import { ungroundedRequirements } from '../graph';

/**
 * `tasks.md` — the Spec Kit hook of the handoff package (F4·A5): one checkbox
 * per requirement and policy node, numbered T001…. A 개발 에이전트 can open
 * the file and start ticking without knowing the app it came from. The body
 * and the evidence grounding ride inside the item, so the checklist stays
 * honest about which line is a guess.
 */

export function buildTasksMd(input: { project: Project; generatedAt: string }): string {
  const { project, generatedAt } = input;
  const evidenceIds = new Set(project.evidence.map((row) => row.id));
  const evidenceTitle = new Map(project.evidence.map((row) => [row.id, row.title] as const));
  const ungrounded = new Set(ungroundedRequirements(project).map((node) => node.id));

  const refsOf = (nodeId: string): string[] =>
    project.graph.links
      .filter((link) => link.type === 'references' && link.src === nodeId && evidenceIds.has(link.dst))
      .map((link) => evidenceTitle.get(link.dst) ?? link.dst);

  const items: { tag: 'req' | 'policy'; node: (typeof project.graph.nodes)[number] }[] = [
    ...project.graph.nodes
      .filter((node) => node.type === 'req')
      .map((node) => ({ tag: 'req' as const, node })),
    ...project.graph.nodes
      .filter((node) => node.type === 'policy')
      .map((node) => ({ tag: 'policy' as const, node })),
  ];

  const lines: string[] = [
    `# tasks.md — ${project.name}`,
    '',
    `> Spec Studio 전달 패키지 · 생성 ${generatedAt} — 요구사항·정책 체크리스트`,
    '',
  ];

  if (items.length === 0) {
    lines.push('체크리스트로 넘길 요구사항·정책 노드가 없습니다.', '');
    return `${lines.join('\n')}\n`;
  }

  items.forEach(({ tag, node }, index) => {
    const taskId = `T${String(index + 1).padStart(3, '0')}`;
    lines.push(`- [ ] ${taskId} [${tag}] ${node.title}`);
    const body = node.body.trim();
    if (body !== '') lines.push(`  ${body.replaceAll('\n', ' ')}`);
    const refs = refsOf(node.id);
    if (refs.length > 0) {
      lines.push(`  근거: ${refs.join(', ')}`);
    } else if (tag === 'req' && ungrounded.has(node.id)) {
      lines.push('  *(근거 없음 — 리서치 보드에 근거를 모아야 합니다)*');
    }
  });

  return `${lines.join('\n')}\n`;
}
