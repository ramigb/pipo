// @pipo/runner: the TypeScript side of the runner (docs/spec.md §7.1, D73). The runner itself is the Rust binary
// `pipo-runner` (crates/pipo-runner); this package finds and starts it, talks to it over its control socket, reads its
// registry and journal, and holds what the engine and CLI need besides: bots, agent settings, probes and spend.
export {
  type AgentProbe,
  type AgentSettings,
  type EngineSpend,
  engineSpend,
  homeAgentBudget,
  probeAgents,
  readAgentSettings,
} from "./agents";
export { compilerArgv, RunnerBinaryError, runnerBinary, runnerEnv } from "./binary";
export {
  BOT_NAME,
  type BotConfig,
  BotsError,
  type BotsFile,
  botId,
  botProblems,
  isReference,
  readBots,
  TELEGRAM_API,
  TelegramError,
  telegramCall,
  writeBots,
} from "./bots";
export {
  type ClientOptions,
  ControlClient,
  type RegistryEntry,
  readRegistryEntry,
  registryPath,
} from "./control/client";
export {
  ControlError,
  type ControlErrorBody,
  type ErrorCode,
  OPS,
  type Op,
  PROTOCOL,
  socketPath,
} from "./control/protocol";
export {
  offlineRead,
  type PacketPage,
  type PacketSummary,
  READ_OPS,
  type ReadOp,
  type TraceStep,
  type UnitTrace,
} from "./control/reads";
export type { VersionDiff, VersionList, VersionSummary } from "./control/versions";
export { runForeground } from "./foreground";
export { ulid } from "./ids";
export { ESCALATED, IN_FLIGHT, Journal, type PacketRow, type PacketState, PENDING, TERMINAL } from "./journal";
export { entryAlive, type Liveness, pidReused, pidRunning, processStartedAt, procStart } from "./liveness";
export {
  type AuthorKind,
  PROPOSAL_STATES,
  type ProblemCode,
  type Proposal,
  type ProposalProblem,
  type ProposalState,
  type ProposalSummary,
} from "./proposals";
export { defaultResolver, type Resolver, Secrets } from "./secrets";
export {
  type Fixture,
  FixtureError,
  type FixtureMeta,
  type FixtureResult,
  type Gap,
  loadFixtures,
  parseFixture,
  type Stubs,
  TEST_NOW,
  TEST_OUTCOMES,
  TEST_VERSION,
  type TestCall,
  type TestError,
  type TestOptions,
  type TestOutcome,
  TestPrepareError,
  type TestReport,
  type TestStep,
  type TestTap,
  type TestUnit,
  type TestWrite,
  testPipeline,
  type UnitOutcome,
} from "./testing";
