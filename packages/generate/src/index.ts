// Isomorphic API of the generator. Node-only parts (files, cutouts, CLI) live in ./node.
export {
  DesignPlanSchema,
  ImageSlotSchema,
  LayoutSchema,
  PlanElementSchema,
  parsePlan,
  validatePlan,
} from './plan.js';
export type {
  DesignPlan,
  ImageSlot,
  Layout,
  PlanContext,
  PlanElement,
  PlanImage,
  PlanParseResult,
  PlanShape,
  PlanText,
} from './plan.js';
export { NO_TEXT, SUBJECT_BACKDROP, buildImagePrompt, describeTextZones } from './image-prompt.js';
export type { ZoneElement } from './image-prompt.js';
export { assembleDesign, fitBox } from './assemble.js';
export type { SlotImage } from './assemble.js';
export { candidateVariant, ctaShare, rankCandidates, roleShares, seedFrom } from './select.js';
export {
  BudgetExceededError,
  budgetedEditor,
  createMemoryLedger,
  worstCaseLlmCallUsd,
} from './spend.js';
export type { SpendEntry, SpendLedger } from './spend.js';
export type { BackgroundRemover, Cutout } from './cutout.js';
export { closestAspectRatio } from './providers/types.js';
export type {
  FetchLike,
  GeneratedImage,
  ImageKind,
  ImageProvider,
  ImageRequest,
} from './providers/types.js';
export { FLUX_ASPECT_RATIOS, FLUX_SCHNELL, createReplicateFluxProvider } from './providers/replicate.js';
export type { ReplicateOptions } from './providers/replicate.js';
export { PEXELS_LICENSE, createPexelsProvider } from './providers/pexels.js';
export type { PexelsOptions } from './providers/pexels.js';
export { BUNDLED_FONTS } from './director/types.js';
export type { ArtDirector, CreativeBrief, DirectorResult, UserImageInfo } from './director/types.js';
export { createTemplateArtDirector, headlineFromPrompt, templatePlan } from './director/template.js';
export {
  PLAN_TOOL_NAME,
  buildDirectorMessage,
  buildDirectorSystemPrompt,
  createAnthropicArtDirector,
  designPlanTool,
} from './director/anthropic.js';
export type { AnthropicDirectorOptions } from './director/anthropic.js';
