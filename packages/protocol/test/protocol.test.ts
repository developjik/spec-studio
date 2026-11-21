import { describe, expect, it } from 'vitest';
import {
  AiProposalRequestSchema,
  AiTestRequestSchema,
  CommandSchema,
  ObjectSchema,
  ProjectBundleSchema,
  ProjectSchema,
  ScreenRefSchema,
  ScreenSchema,
  parseImageDataUrl,
} from '../src';

const AT = '2026-11-19T09:00:00.000Z';

const goal = {
  id: `G_${'a'.repeat(12)}`,
  kind: 'goal' as const,
  subtype: null,
  title: '취소 문의 30% 감소',
  parentId: null,
  props: {},
  state: 'active',
  rev: 1,
  hash: 'h1',
  deletedAt: null,
  createdAt: AT,
  updatedAt: AT,
};

const pin = {
  id: `P_${'b'.repeat(12)}`,
  kind: 'pin' as const,
  subtype: 'policy',
  title: '배송 전 취소 가능',
  parentId: `S_${'c'.repeat(12)}`,
  props: {},
  state: 'open',
  rev: 1,
  hash: 'h2',
  deletedAt: null,
  createdAt: AT,
  updatedAt: AT,
};

// §5.2: idea shares I_ with insight; evidence takes E. Both stand alone.
const idea = {
  ...goal,
  id: `I_${'d'.repeat(12)}`,
  kind: 'idea' as const,
  state: 'captured',
};

const evidence = {
  ...goal,
  id: `E_${'e'.repeat(12)}`,
  kind: 'evidence' as const,
  state: 'cited',
};

describe('objects mirror the database constraints', () => {
  it('accepts a well-formed goal and pin', () => {
    expect(ObjectSchema.safeParse(goal).success).toBe(true);
    expect(ObjectSchema.safeParse(pin).success).toBe(true);
  });

  it('refuses a pin without its screen', () => {
    const result = ObjectSchema.safeParse({ ...pin, parentId: null });
    expect(result.success).toBe(false);
  });

  it('refuses a pin whose parent is not a screen', () => {
    const result = ObjectSchema.safeParse({ ...pin, parentId: goal.id });
    expect(result.success).toBe(false);
  });

  it('refuses an unknown pin subtype', () => {
    expect(ObjectSchema.safeParse({ ...pin, subtype: 'wibble' }).success).toBe(false);
    expect(ObjectSchema.safeParse({ ...pin, subtype: null }).success).toBe(false);
  });

  it('refuses a subtype on kinds that have none', () => {
    expect(ObjectSchema.safeParse({ ...goal, subtype: 'policy' }).success).toBe(false);
  });

  it('refuses a specnode without a subtype', () => {
    const node = { ...goal, id: `N_${'d'.repeat(12)}`, kind: 'specnode', subtype: null };
    expect(ObjectSchema.safeParse(node).success).toBe(false);
  });

  it('keeps state machines per kind', () => {
    expect(ObjectSchema.safeParse({ ...goal, state: 'in-progress' }).success).toBe(false);
    const policy = { ...pin, state: 'agreed' };
    expect(ObjectSchema.safeParse(policy).success).toBe(false);
  });

  it('accepts a captured idea and a cited evidence', () => {
    expect(ObjectSchema.safeParse(idea).success).toBe(true);
    expect(ObjectSchema.safeParse(evidence).success).toBe(true);
  });

  it('refuses a subtype or a parent on idea/evidence', () => {
    expect(ObjectSchema.safeParse({ ...idea, subtype: 'policy' }).success).toBe(false);
    expect(ObjectSchema.safeParse({ ...evidence, subtype: 'capture' }).success).toBe(false);
    expect(ObjectSchema.safeParse({ ...idea, parentId: pin.parentId }).success).toBe(false);
    expect(ObjectSchema.safeParse({ ...evidence, parentId: pin.parentId }).success).toBe(false);
  });

  it('keeps idea/evidence state machines', () => {
    expect(ObjectSchema.safeParse({ ...idea, state: 'promoted' }).success).toBe(true);
    expect(ObjectSchema.safeParse({ ...idea, state: 'active' }).success).toBe(false);
    expect(ObjectSchema.safeParse({ ...evidence, state: 'dismissed' }).success).toBe(true);
    expect(ObjectSchema.safeParse({ ...evidence, state: 'open' }).success).toBe(false);
  });
});

describe('screen refs', () => {
  it('requires a value for an image', () => {
    expect(ScreenRefSchema.safeParse({ kind: 'image', value: '' }).success).toBe(false);
  });

  it('accepts only an image data URL it is willing to embed', () => {
    const image = (value: string) => ScreenRefSchema.safeParse({ kind: 'image', value }).success;

    expect(image('data:image/png;base64,AA==')).toBe(true);
    expect(image('data:image/jpeg;base64,/9j/4AAQ')).toBe(true);
    expect(image('data:image/webp;base64,UklGRg==')).toBe(true);
    expect(image('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22x%22%2F%3E')).toBe(true);

    // A link is not an image and would be fetched over the network.
    expect(image('https://example.com/shot.png')).toBe(false);
    // A scriptable document pretending to be a screenshot is refused.
    expect(image('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==')).toBe(false);
    expect(image('data:application/xhtml+xml;base64,PHNjcmlwdD4=')).toBe(false);
    // The mime is where an attribute injection would ride in, and the payload
    // must stay base64.
    expect(image('data:image/png" onerror="alert(1);base64,AA==')).toBe(false);
    expect(image('data:image/png;base64,AA==<script>alert(1)</script>')).toBe(false);
    expect(image('data:image/png;base64,')).toBe(false);
  });

  it('reads a data URL into its mime and payload without trusting either', () => {
    expect(parseImageDataUrl('data:image/png;base64,AA==')).toEqual({
      mime: 'image/png',
      base64: true,
      payload: 'AA==',
    });
    expect(parseImageDataUrl('data:image/jpg;base64,AA==')?.mime).toBe('image/jpeg');
    expect(parseImageDataUrl('data:image/svg+xml,%3Csvg%2F%3E')?.base64).toBe(false);
    expect(parseImageDataUrl('data:text/html;base64,AA==')).toBeNull();
    expect(parseImageDataUrl('data:image/svg+xml,%E0%A4%A')).toBeNull();
  });

  it('requires a URL for a Figma frame', () => {
    expect(ScreenRefSchema.safeParse({ kind: 'figma_frame', value: 'not a url' }).success).toBe(
      false,
    );
    expect(
      ScreenRefSchema.safeParse({
        kind: 'figma_frame',
        value: 'https://www.figma.com/file/abc/Frame',
      }).success,
    ).toBe(true);
  });

  it('formats screen codes as SCR-###', () => {
    const screen = {
      id: `S_${'c'.repeat(12)}`,
      title: '주문 상세',
      code: 'SCR-110',
      ref: { kind: 'image', value: 'data:image/png;base64,AA==' },
      viewport: { width: 1200, height: 800 },
      createdAt: AT,
      updatedAt: AT,
    };
    expect(ScreenSchema.safeParse(screen).success).toBe(true);
    expect(ScreenSchema.safeParse({ ...screen, code: '110' }).success).toBe(false);
  });
});

describe('commands', () => {
  it('trims a pin title and rejects an empty one', () => {
    const parsed = CommandSchema.safeParse({
      type: 'pin.create',
      screenId: `S_${'c'.repeat(12)}`,
      pinType: 'policy',
      title: '  배송 전 취소 가능  ',
      body: '',
      anchor: { x: 0.25, y: 0.5 },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'pin.create') {
      expect(parsed.data.title).toBe('배송 전 취소 가능');
    }

    expect(
      CommandSchema.safeParse({
        type: 'pin.create',
        screenId: `S_${'c'.repeat(12)}`,
        pinType: 'policy',
        title: '   ',
        body: '',
        anchor: { x: 0.25, y: 0.5 },
      }).success,
    ).toBe(false);
  });

  it('has no field anywhere that assigns a pin number', () => {
    const parsed = CommandSchema.safeParse({
      type: 'pin.create',
      screenId: `S_${'c'.repeat(12)}`,
      pinType: 'function',
      title: 'x',
      body: '',
      anchor: { x: 0, y: 1 },
      number: 99,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect('number' in parsed.data).toBe(false);
  });

  it('requires an anchor inside the screen', () => {
    expect(
      CommandSchema.safeParse({
        type: 'pin.create',
        screenId: `S_${'c'.repeat(12)}`,
        pinType: 'function',
        title: 'x',
        body: '',
        anchor: { x: 1.2, y: 0.5 },
      }).success,
    ).toBe(false);
  });
});

describe('project', () => {
  it('round-trips a project with pins', () => {
    const project = {
      version: 1 as const,
      id: 'PRJ_000000000001',
      name: '주문 취소 정책',
      screen: {
        id: `S_${'c'.repeat(12)}`,
        title: '주문 상세',
        code: 'SCR-110',
        ref: { kind: 'image' as const, value: 'data:image/png;base64,AA==' },
        viewport: null,
        createdAt: AT,
        updatedAt: AT,
      },
      pins: [
        {
          id: `P_${'e'.repeat(12)}`,
          screenId: `S_${'c'.repeat(12)}`,
          number: 1,
          type: 'function' as const,
          title: '취소 버튼',
          body: '',
          anchor: { x: 0.1, y: 0.2 },
          createdAt: AT,
          updatedAt: AT,
        },
      ],
      pinSeq: 1,
      createdAt: AT,
      updatedAt: AT,
    };
    const parsed = ProjectSchema.safeParse(project);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.pins[0]?.number).toBe(1);
  });
});

describe('ai endpoint', () => {
  it('takes http(s) urls only, on the request and on the probe', () => {
    const request = { mode: 'graph' as const, provider: 'openai' as const, apiKey: null };
    expect(
      AiProposalRequestSchema.safeParse({ ...request, endpoint: 'http://127.0.0.1:1234/v1' }).success,
    ).toBe(true);
    expect(
      AiProposalRequestSchema.safeParse({ ...request, endpoint: 'https://api.openai.com/v1' }).success,
    ).toBe(true);
    for (const endpoint of ['file:///etc/passwd', 'data:text/plain,hello', 'ftp://example.com']) {
      expect(AiProposalRequestSchema.safeParse({ ...request, endpoint }).success).toBe(false);
      expect(AiTestRequestSchema.safeParse({ ...request, endpoint }).success).toBe(false);
    }
  });
});

describe('bundle (W3/F5)', () => {
  const legacyDoc = {
    id: `D_${'d'.repeat(12)}`,
    title: '주문 상세 문서',
    rev: 2,
    blocks: [
      {
        id: `B_${'b'.repeat(12)}`,
        type: 'paragraph' as const,
        text: '배송이 시작되기 전까지만 취소할 수 있다.',
        pinRefs: [],
        createdAt: AT,
        updatedAt: AT,
      },
    ],
    createdAt: AT,
    updatedAt: AT,
  };

  it('reads a pre-registry bundle (one `doc`) as a one-doc registry', () => {
    const bundle = {
      format: 'spec-studio.bundle',
      version: 1 as const,
      exportedAt: AT,
      project: {
        version: 1 as const,
        id: 'PRJ_000000000001',
        name: '주문 취소 정책',
        screen: null,
        pins: [],
        pinSeq: 0,
        doc: legacyDoc,
        proposal: null,
        graph: { nodes: [], links: [] },
        graphProposal: null,
        createdAt: AT,
        updatedAt: AT,
      },
    };
    const parsed = ProjectBundleSchema.safeParse(bundle);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.project.docs).toHaveLength(1);
    expect(parsed.data.project.docs[0]).toMatchObject({
      id: legacyDoc.id,
      kind: 'spec',
      deletedAt: null,
    });
    expect('doc' in parsed.data.project).toBe(false);
  });

  it('reads a registry bundle as-is, kinds and all', () => {
    const bundle = {
      format: 'spec-studio.bundle',
      version: 1 as const,
      exportedAt: AT,
      project: {
        version: 1 as const,
        id: 'PRJ_000000000002',
        name: '주문 취소 정책',
        screen: null,
        pins: [],
        pinSeq: 0,
        docs: [legacyDoc, { ...legacyDoc, id: `D_${'r'.repeat(12)}`, kind: 'research' }],
        proposals: [],
        graph: { nodes: [], links: [] },
        graphProposal: null,
        createdAt: AT,
        updatedAt: AT,
      },
    };
    const parsed = ProjectBundleSchema.safeParse(bundle);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.project.docs.map((doc) => doc.kind)).toEqual(['spec', 'research']);
    }
  });
});
