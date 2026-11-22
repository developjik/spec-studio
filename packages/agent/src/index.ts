/**
 * @spec-studio/agent — the run runtime core (E3 F1).
 *
 * Pure and port-driven: the state machine decides which move is legal, the
 * driver runs the multi-turn loop, and every effect — model, tools, journal,
 * persistence — arrives as a port the daemon supplies. This package imports
 * the protocol and nothing else of ours.
 */
export {
  isTerminalRunState,
  machineTransition,
  personTransition,
  RunRefusal,
  RUN_STATES,
  RUN_TERMINAL_STATES,
  type PersonRunCommand,
  type RunRecord,
  type RunRefusalCode,
  type RunSeed,
} from './runtime';
export {
  driveRun,
  type DriveOptions,
  type Journal,
  type JournalLine,
  type ModelPort,
  type RunOutcome,
  type ToolBox,
} from './loop';
export { washBriefDraft, type WashResult } from './grounding';
