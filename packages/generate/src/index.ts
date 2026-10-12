// Isomorphic API of the generator. Node-only parts (files, cutouts, CLI) live in ./node.
export {
  DesignPlanSchema,
  ImageSlotSchema,
  LayoutSchema,
  PlanElementSchema,
  ToolDesignPlanSchema,
  ToolLayoutSchema,
  fromToolPlan,
  parsePlan,
  salvagePlan,
  toToolPlan,
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
  ToolDesignPlan,
} from './plan.js';
export { NO_TEXT, SUBJECT_BACKDROP, buildImagePrompt, describeTextZones } from './image-prompt.js';
export type { ZoneElement } from './image-prompt.js';
export { assembleDesign, centerButtonLabels, fitBox } from './assemble.js';
export type { SlotImage } from './assemble.js';
export { candidateVariant, ctaShare, rankCandidates, roleShares, seedFrom } from './select.js';
export {
  BudgetExceededError,
  budgetedEditor,
  createMemoryLedger,
  worstCaseLlmCallUsd,
} from './spend.js';
export type { SpendEntry, SpendLedger } from './spend.js';
export type { BackgroundRemover, Cutout, RemoverKind } from './cutout.js';
export {
  DEFAULT_SHADOW_OPACITY,
  MAX_SHADOW_OPACITY,
  MIN_SHADOW_OPACITY,
  contactShadow,
  setContactShadow,
  shadowIdFor,
  syncContactShadows,
} from './shadow.js';
export type { Footprint } from './shadow.js';
export { closestAspectRatio } from './providers/types.js';
export type {
  FetchLike,
  GeneratedImage,
  ImageKind,
  ImageProvider,
  ImageRequest,
} from './providers/types.js';
export {
  FLUX_ASPECT_RATIOS,
  FLUX_SCHNELL,
  createReplicateFluxProvider,
} from './providers/replicate.js';
export { createReplicateClient } from './providers/replicate-client.js';
export type {
  Prediction,
  ReplicateClient,
  ReplicateOptions,
} from './providers/replicate-client.js';
export { PEXELS_LICENSE, createPexelsProvider } from './providers/pexels.js';
export type { PexelsOptions } from './providers/pexels.js';
export { ArtDirectorError, BUNDLED_FONTS } from './director/types.js';
export type {
  ArtDirector,
  CreativeBrief,
  DirectorResult,
  UserImageInfo,
} from './director/types.js';
export {
  createTemplateArtDirector,
  headlineFromPrompt,
  templatePlan,
} from './director/template.js';
export {
  buildDirectorMessage,
  buildDirectorSystemPrompt,
  createAnthropicArtDirector,
  designPlanSchema,
} from './director/anthropic.js';
export type { AnthropicDirectorOptions } from './director/anthropic.js';
export {
  checkFactReplacement,
  createCopyGroundedRule,
  describeFacts,
  extractFacts,
  findUngroundedFacts,
  isGrounded,
  placeholderFor,
  planFactProblems,
} from './grounding.js';
export type { Fact, FactKind } from './grounding.js';
export {
  DEFAULT_JUDGE_MODEL,
  buildJudgeMessage,
  buildJudgeSystemPrompt,
  buildPairSystemPrompt,
  createAnthropicJudge,
  worstCaseJudgeCallUsd,
} from './judge/anthropic.js';
export type { AnthropicJudgeOptions } from './judge/anthropic.js';
export { comparePair, seededRandom } from './judge/pairwise.js';
export type { PairOutcome } from './judge/pairwise.js';
export {
  createJudgeStore,
  designFingerprint,
  elementFingerprint,
  judgeElements,
  judgeKnownIssues,
} from './judge/rule.js';
export type { JudgeStore } from './judge/rule.js';
export { createScriptedJudge } from './judge/scripted.js';
export {
  FINDING_CATEGORIES,
  JudgeFindingSchema,
  JudgeVerdictSchema,
  PairVerdictSchema,
} from './judge/types.js';
export type {
  JudgeElement,
  JudgeFinding,
  JudgeKnownIssue,
  JudgeRequest,
  JudgeVerdict,
  PairRequest,
  PairVerdict,
  VisualJudge,
} from './judge/types.js';
export { createKeyElementsVisibleRule } from './key-elements.js';
