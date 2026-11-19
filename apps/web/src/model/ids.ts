const SUFFIX_LENGTH = 12;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomSuffix(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += ALPHABET.charAt(byte % ALPHABET.length);
  return out;
}

export function newScreenId(): string {
  return `S_${randomSuffix(SUFFIX_LENGTH)}`;
}

export function newPinId(): string {
  return `P_${randomSuffix(SUFFIX_LENGTH)}`;
}

export function newProjectId(): string {
  return `PRJ_${randomSuffix(SUFFIX_LENGTH)}`;
}

export function newDocId(): string {
  return `D_${randomSuffix(SUFFIX_LENGTH)}`;
}

export function newBlockId(): string {
  return `B_${randomSuffix(SUFFIX_LENGTH)}`;
}

export function newProposalId(): string {
  return `PR_${randomSuffix(SUFFIX_LENGTH)}`;
}

export function newLinkId(): string {
  return `L_${randomSuffix(SUFFIX_LENGTH)}`;
}

export function newGraphProposalId(): string {
  return `GP_${randomSuffix(SUFFIX_LENGTH)}`;
}

/** Browser-mode id source: the same prefixes the daemon hands out. */
export function nextEntityId(
  kind: 'project' | 'screen' | 'pin' | 'doc' | 'block' | 'proposal' | 'node' | 'link' | 'graphProposal',
  nodeType?: 'req' | 'policy' | 'contract' | 'qa',
): string {
  switch (kind) {
    case 'project':
      return newProjectId();
    case 'node':
      return nodeType === 'contract'
        ? `C_${randomSuffix(SUFFIX_LENGTH)}`
        : nodeType === 'qa'
          ? `V_${randomSuffix(SUFFIX_LENGTH)}`
          : `N_${randomSuffix(SUFFIX_LENGTH)}`;
    case 'link':
      return newLinkId();
    case 'graphProposal':
      return newGraphProposalId();
    case 'screen':
      return newScreenId();
    case 'pin':
      return newPinId();
    case 'doc':
      return newDocId();
    case 'block':
      return newBlockId();
    case 'proposal':
      return newProposalId();
  }
}
