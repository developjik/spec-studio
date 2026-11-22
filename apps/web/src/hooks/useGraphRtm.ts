import { useState } from 'react';
import type { Command, Project } from '@spec-studio/protocol';
import type { StudioView } from '../components/TopBar';
import { nowIso, type ApplyResult, type Notice } from '../model/appUtils';
import type { RevertableView } from '../model/daemon';

/**
 * 그래프/RTM 영역: the studio↔graph view switch, the selected node, and the
 * graph proposal + node/link commands GraphView fires.
 */
export function useGraphRtm({
  project,
  runDoc,
  reload,
  setRevertable,
  setNotice,
}: {
  project: Project | null;
  runDoc: (command: Command, after?: (result: ApplyResult) => void) => Promise<void>;
  reload: () => Promise<void>;
  setRevertable: (revertable: RevertableView | null) => void;
  setNotice: (notice: Notice | null) => void;
}) {
  const [view, setView] = useState<StudioView>('studio');
  const [selectedGraphId, setSelectedGraphId] = useState<string | null>(null);

  const createGraphProposal = () => {
    void runDoc({ type: 'graph.proposal.create' }, (result) => {
      const summary = result.project.graphProposal?.summary ?? '';
      setNotice({ tone: 'info', text: summary });
      setSelectedGraphId(null);
    });
  };

  const adoptGraphProposal = () => {
    const proposal = project?.graphProposal ?? null;
    if (proposal === null) return;
    void runDoc({ type: 'graph.proposal.adopt', proposalId: proposal.id }, (result) => {
      setNotice({
        tone: 'info',
        text: `초안 ${proposal.nodes.length}개와 링크 ${proposal.links.length}개를 만들었습니다.`,
      });
      if (result.opSeq !== undefined) {
        setRevertable({
          seq: result.opSeq,
          at: nowIso(),
          summary: proposal.summary,
          blocks: 0,
          kind: 'graph',
          op: 'graph.proposal.adopt',
          nodes: proposal.nodes.length,
          proposalId: proposal.id,
        });
      }
      setSelectedGraphId(null);
    });
  };

  const rejectGraphProposal = () => {
    const proposal = project?.graphProposal ?? null;
    if (proposal === null) return;
    void runDoc({ type: 'graph.proposal.reject', proposalId: proposal.id });
  };

  const createGraphNode = (
    nodeType: 'req' | 'policy' | 'contract' | 'qa',
    title: string,
    body: string,
  ) => {
    void runDoc({ type: 'node.create', nodeType, title, body }, (result) => {
      setSelectedGraphId(result.project.graph.nodes.at(-1)?.id ?? null);
    });
  };

  const updateGraphNode = (
    nodeId: string,
    patch: { title?: string; body?: string; state?: string },
  ) => {
    void runDoc({ type: 'node.update', nodeId, ...patch });
  };

  const deleteGraphNode = (nodeId: string) => {
    void runDoc({ type: 'node.delete', nodeId }, () => {
      if (selectedGraphId === nodeId) setSelectedGraphId(null);
    });
  };

  const createGraphLink = (linkType: string, src: string, dst: string) => {
    void runDoc({ type: 'link.create', linkType, src, dst } as Command, () => void reload());
  };

  const deleteGraphLink = (linkId: string) => {
    void runDoc({ type: 'link.delete', linkId }, () => void reload());
  };

  const ackGraphLink = (linkId: string) => {
    void runDoc({ type: 'link.ack', linkId });
  };

  return {
    view,
    setView,
    selectedGraphId,
    setSelectedGraphId,
    createGraphProposal,
    adoptGraphProposal,
    rejectGraphProposal,
    createGraphNode,
    updateGraphNode,
    deleteGraphNode,
    createGraphLink,
    deleteGraphLink,
    ackGraphLink,
  };
}
