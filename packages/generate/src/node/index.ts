// Node-only entry point: @simonlunay/redline-generate/node
export { GENERATE_HELP, GenerateUsageError, parseSize, renderGenerationSteps, runGenerateCommand, slugify } from './generate-command.js';
export type { GenerateCommandIO } from './generate-command.js';
export { generateDesign, serializeResult } from './pipeline.js';
export type {
  CandidateResult,
  GenerateEvent,
  GenerateOptions,
  GenerationResult,
  UserImageInput,
} from './pipeline.js';
export { AssetStore } from './assets.js';
export type { Manifest, ManifestEntry } from './assets.js';
export { MOCK_BACKDROP, createMockImageProvider, prng } from './mock-provider.js';
export {
  BIREFNET_LITE,
  applyMaskAndTrim,
  createAutoRemover,
  createBackdropKeyRemover,
  createBiRefNetRemover,
} from './cutout.js';
export { createWorkspace } from './workspace.js';
export type { Workspace } from './workspace.js';
export { renderContactSheet } from './contact-sheet.js';
export type { SheetColumn } from './contact-sheet.js';
export { createFileLedger } from './spend-file.js';
export * from '../index.js';
