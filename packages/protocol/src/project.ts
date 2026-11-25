import { z } from 'zod';
import { DocSchema } from './doc';
import { EvidenceSchema } from './evidence';
import { GraphProposalSchema, GraphSchema } from './graph';
import { IdeaSchema } from './idea';
import { PinSchema } from './pin';
import { ProposalSchema } from './proposal';
import { ScreenSchema } from './screen';

/** A project holds ordered screens. screen/pinSeq are active-screen aliases.
 * Optional multi-screen fields admit legacy v1 bundles; normalization fills them.
 */
export const ProjectSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  /** Compatibility alias of the active screen. */
  screen: ScreenSchema.nullable(),
  screens: z.array(ScreenSchema).optional(),
  activeScreenId: z.string().nullable().optional(),
  screenPinSeq: z.record(z.string(), z.number().int().min(0)).optional(),
  pins: z.array(PinSchema),
  pinSeq: z.number().int().min(0),
  docs: z.array(DocSchema).default([]),
  proposals: z.array(ProposalSchema).default([]),
  /**
   * v1 object graph: the four editable node kinds and the seven named links.
   * Screens and pins live in their own fields above; the graph view joins the
   * two sets when it renders. Keeping them apart means the graph could be added
   * to an old project without touching a single screen or pin.
   */
  graph: GraphSchema.default({ nodes: [], links: [] }),
  /** The pin-derived drafts waiting for one decision, or the last decision. */
  graphProposal: GraphProposalSchema.nullable().default(null),
  /**
   * The idea inbox and the research board's evidence (E1 §4 F2·F3). Both are
   * `obj` kinds without a parent or a canvas node; they live here the way pins
   * do so a capture and the links that cite it share one transaction.
   */
  ideas: z.array(IdeaSchema).default([]),
  evidence: z.array(EvidenceSchema).default([]),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type Project = z.infer<typeof ProjectSchema>;

export const ProjectFileSchema = ProjectSchema;
export type ProjectFile = Project;

/**
 * The file a person keeps. It is the project state the store would read back,
 * wrapped with the two facts a reader needs before trusting it: what it is and
 * when it left. Import remaps every id, so a bundle can be opened twice.
 */
export const ProjectBundleSchema = z.object({
  format: z.literal('spec-studio.bundle'),
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  exportedAt: z.string().min(1),
  project: z.preprocess(normalizeLegacyProject, ProjectSchema),
});
export type ProjectBundle = z.infer<typeof ProjectBundleSchema>;

/**
 * Bundles written before the registry carry one `doc` instead of `docs`;
 * reading one is the same as reading a registry with a single spec document.
 */
export function normalizeLegacyProject(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const value = raw as Record<string, unknown>;
  if ('docs' in value || !('doc' in value)) return raw;
  return { ...value, docs: value.doc === null ? [] : [value.doc] };
}

/** Readers predating rich blocks must reject rather than silently strip their data. */
export function bundleVersion(project: Project):1|2|3 {
 if(project.docs.some(doc=>doc.blocks.some(block=>!['paragraph','heading','list','caption'].includes(block.type)||block.data!==undefined))) return 3;
 return (project.screens?.length??0)>1 ? 2 : 1;
}
