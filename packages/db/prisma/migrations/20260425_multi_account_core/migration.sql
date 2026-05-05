-- =====================================================================
-- Multi-account / funded-trading core migration
-- Adds enums + tables + nullable accountId columns on existing tables.
-- Designed to be safe on an existing single-account database:
--   * All new columns on existing tables are nullable.
--   * Backfill runs in seed/backfill script (see migration 20260426).
--   * Enforce-NOT-NULL runs in a subsequent migration (20260427).
-- =====================================================================

-- =====================================================================
-- Enums
-- =====================================================================

CREATE TYPE "AccountKind" AS ENUM ('PROP', 'PERSONAL', 'DEMO');

CREATE TYPE "AccountPhaseKind" AS ENUM (
    'EVALUATION',
    'VERIFICATION',
    'FUNDED',
    'PAYOUT_PROTECT',
    'SCALE_UP',
    'BREACHED',
    'PASSED',
    'PERSONAL'
);

CREATE TYPE "AccountPhaseOutcome" AS ENUM (
    'IN_PROGRESS',
    'PASSED',
    'FAILED',
    'WITHDRAWN'
);

CREATE TYPE "AccountMode" AS ENUM (
    'NORMAL',
    'CAUTIOUS',
    'RECOVERY',
    'TARGET_NEAR',
    'PAYOUT_PROTECT',
    'LOCKED'
);

CREATE TYPE "AccountHealth" AS ENUM (
    'HEALTHY',
    'WARNING',
    'CRITICAL',
    'BREACHED'
);

CREATE TYPE "AllocationPolicy" AS ENUM (
    'ONE_ACCOUNT_ONLY',
    'MAX_N_ACCOUNTS',
    'ALL_ELIGIBLE',
    'CHALLENGE_ONLY',
    'FUNDED_ONLY',
    'STRATEGY_TAGGED'
);

CREATE TYPE "AllocationStatus" AS ENUM (
    'PENDING',
    'ALLOCATED',
    'SKIPPED',
    'PARTIAL',
    'FAILED'
);

CREATE TYPE "SupervisionAction" AS ENUM (
    'HOLD',
    'TIGHTEN_STOP',
    'MOVE_TO_BREAKEVEN',
    'SCALE_OUT',
    'CLOSE',
    'FORCE_CLOSE_BREACH',
    'BLOCK_NEW_TRADES',
    'LOCK_ACCOUNT',
    'ENABLE_CAUTIOUS',
    'ENABLE_RECOVERY',
    'ENABLE_PAYOUT_PROTECT'
);

CREATE TYPE "SupervisionActionOrigin" AS ENUM (
    'DETERMINISTIC',
    'AI_SUGGESTED',
    'MANUAL'
);

CREATE TYPE "AiReviewKind" AS ENUM (
    'PRE_TRADE_CRITIC',
    'POSITION_SUPERVISOR',
    'POST_TRADE_JOURNAL',
    'WEEKLY_REVIEW',
    'NATURAL_LANGUAGE_QUERY',
    'NEWS_REVIEW',
    'RULE_DRIFT_REVIEW',
    'SETUP_QUALITY_REVIEW'
);

CREATE TYPE "AiVerdict" AS ENUM (
    'APPROVE',
    'APPROVE_WITH_CAUTION',
    'SUGGEST_REDUCE_SIZE',
    'SUGGEST_TIGHTEN_STOP',
    'SUGGEST_SCALE_OUT',
    'SUGGEST_CLOSE',
    'NEUTRAL',
    'CONCERNED',
    'OBJECT',
    'NO_ACTION'
);

CREATE TYPE "RuleViolationOutcome" AS ENUM (
    'BLOCKED',
    'REDUCED',
    'WARNED',
    'RECORDED',
    'FORCED_CLOSE'
);

CREATE TYPE "JournalExportStatus" AS ENUM (
    'PENDING',
    'WRITTEN',
    'STALE',
    'FAILED',
    'SUPERSEDED'
);

CREATE TYPE "JournalNoteKind" AS ENUM (
    'DAILY_SUMMARY',
    'WEEKLY_REVIEW',
    'SETUP_CARD',
    'TRADE_NOTE',
    'RULE_VIOLATION',
    'AI_LESSON',
    'ACCOUNT_OVERVIEW',
    'NEWS_BRIEF',
    'RUNBOOK'
);

CREATE TYPE "BridgeHealthStatus" AS ENUM (
    'CONNECTED',
    'DEGRADED',
    'STALE',
    'DISCONNECTED',
    'ERROR'
);

CREATE TYPE "AiLessonSource" AS ENUM (
    'POST_TRADE',
    'WEEKLY',
    'MANUAL',
    'BACKTEST'
);

CREATE TYPE "PortfolioBucketKind" AS ENUM (
    'SYMBOL',
    'CORRELATION_GROUP',
    'ASSET_CLASS'
);

-- =====================================================================
-- Account / AccountPhase / AccountRuleProfile / AccountDailyMetric
-- =====================================================================

CREATE TABLE "Account" (
    "id"                    TEXT        NOT NULL,
    "displayName"           TEXT        NOT NULL,
    "kind"                  "AccountKind" NOT NULL,
    "providerName"          TEXT        NOT NULL,
    "brokerAccountLogin"    TEXT,
    "integrationId"         TEXT        NOT NULL,
    "currency"              TEXT        NOT NULL DEFAULT 'USD',
    "startingBalance"       DOUBLE PRECISION NOT NULL,
    "mode"                  "AccountMode"   NOT NULL DEFAULT 'NORMAL',
    "health"                "AccountHealth" NOT NULL DEFAULT 'HEALTHY',
    "isActive"              BOOLEAN     NOT NULL DEFAULT true,
    "currentPhaseId"        TEXT,
    "activeRuleProfileId"   TEXT,
    "tradingMode"           "TradingMode"   NOT NULL DEFAULT 'PAPER',
    "tags"                  JSONB       NOT NULL DEFAULT '[]',
    "notes"                 TEXT,
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Account_displayName_key" ON "Account"("displayName");
CREATE UNIQUE INDEX "Account_currentPhaseId_key" ON "Account"("currentPhaseId");
CREATE UNIQUE INDEX "Account_activeRuleProfileId_key" ON "Account"("activeRuleProfileId");
CREATE INDEX "Account_kind_isActive_idx" ON "Account"("kind", "isActive");
CREATE INDEX "Account_providerName_idx" ON "Account"("providerName");

CREATE TABLE "AccountPhase" (
    "id"                 TEXT NOT NULL,
    "accountId"          TEXT NOT NULL,
    "kind"               "AccountPhaseKind" NOT NULL,
    "isActive"           BOOLEAN NOT NULL DEFAULT true,
    "startedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt"            TIMESTAMP(3),
    "startingBalance"    DOUBLE PRECISION NOT NULL,
    "profitTargetUsd"    DOUBLE PRECISION,
    "dailyLossLimitUsd"  DOUBLE PRECISION NOT NULL,
    "totalLossLimitUsd"  DOUBLE PRECISION NOT NULL,
    "outcome"            "AccountPhaseOutcome" NOT NULL DEFAULT 'IN_PROGRESS',
    "reason"             TEXT,
    "notes"              TEXT,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AccountPhase_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AccountPhase_accountId_isActive_idx" ON "AccountPhase"("accountId", "isActive");
CREATE INDEX "AccountPhase_kind_isActive_idx" ON "AccountPhase"("kind", "isActive");

CREATE TABLE "AccountRuleProfile" (
    "id"                         TEXT NOT NULL,
    "accountId"                  TEXT NOT NULL,
    "version"                    INTEGER NOT NULL DEFAULT 1,
    "isActive"                   BOOLEAN NOT NULL DEFAULT true,
    "providerName"               TEXT NOT NULL,
    "providerRulesUrl"           TEXT,
    "startingBalance"            DOUBLE PRECISION NOT NULL,
    "dailyLossLimitUsd"          DOUBLE PRECISION NOT NULL,
    "totalLossLimitUsd"          DOUBLE PRECISION NOT NULL,
    "trailingDrawdownUsd"        DOUBLE PRECISION,
    "profitTargetUsd"            DOUBLE PRECISION,
    "maxRiskPerTradePct"         DOUBLE PRECISION NOT NULL,
    "maxRiskPerTradeUsd"         DOUBLE PRECISION NOT NULL,
    "minRiskRewardRatio"         DOUBLE PRECISION NOT NULL DEFAULT 1.5,
    "maxOpenPositions"           INTEGER NOT NULL DEFAULT 3,
    "maxConcurrentRiskPct"       DOUBLE PRECISION NOT NULL DEFAULT 0.03,
    "maxCorrelatedPositions"     INTEGER NOT NULL DEFAULT 2,
    "allowedAssetClasses"        JSONB NOT NULL DEFAULT '[]',
    "forbiddenAssetClasses"      JSONB NOT NULL DEFAULT '[]',
    "allowedSessions"            JSONB NOT NULL DEFAULT '[]',
    "forbiddenSessions"          JSONB NOT NULL DEFAULT '[]',
    "allowedTimeframes"          JSONB NOT NULL DEFAULT '[]',
    "noTradeBeforeUtc"           TEXT,
    "noTradeAfterUtc"            TEXT,
    "newsBlackoutMinutesBefore"  INTEGER NOT NULL DEFAULT 0,
    "newsBlackoutMinutesAfter"   INTEGER NOT NULL DEFAULT 0,
    "newsBlackoutUrgencies"      JSONB NOT NULL DEFAULT '[]',
    "blockWeekendHold"           BOOLEAN NOT NULL DEFAULT true,
    "allowHedging"               BOOLEAN NOT NULL DEFAULT false,
    "cautiousLossFraction"       DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "recoveryLossFraction"       DOUBLE PRECISION NOT NULL DEFAULT 0.75,
    "targetNearFraction"         DOUBLE PRECISION,
    "payoutEligibleAfter"        INTEGER NOT NULL DEFAULT 0,
    "payoutProtectWindowDays"    INTEGER NOT NULL DEFAULT 0,
    "createdAt"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AccountRuleProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountRuleProfile_accountId_version_key" ON "AccountRuleProfile"("accountId", "version");
CREATE INDEX "AccountRuleProfile_accountId_isActive_idx" ON "AccountRuleProfile"("accountId", "isActive");

CREATE TABLE "AccountDailyMetric" (
    "id"                 TEXT NOT NULL,
    "accountId"          TEXT NOT NULL,
    "date"               TEXT NOT NULL,
    "startingBalance"    DOUBLE PRECISION NOT NULL,
    "startingEquity"     DOUBLE PRECISION NOT NULL,
    "endingBalance"      DOUBLE PRECISION NOT NULL,
    "endingEquity"       DOUBLE PRECISION NOT NULL,
    "highWaterMark"      DOUBLE PRECISION NOT NULL,
    "lowWaterMark"       DOUBLE PRECISION NOT NULL,
    "realizedPnl"        DOUBLE PRECISION NOT NULL,
    "unrealizedPnlClose" DOUBLE PRECISION NOT NULL,
    "totalFees"          DOUBLE PRECISION NOT NULL,
    "tradesOpened"       INTEGER NOT NULL DEFAULT 0,
    "tradesClosed"       INTEGER NOT NULL DEFAULT 0,
    "winners"            INTEGER NOT NULL DEFAULT 0,
    "losers"             INTEGER NOT NULL DEFAULT 0,
    "dailyLossUsedPct"   DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalLossUsedPct"   DOUBLE PRECISION NOT NULL DEFAULT 0,
    "distanceToTargetPct" DOUBLE PRECISION,
    "rulesViolated"      JSONB NOT NULL DEFAULT '[]',
    "modeEnded"          "AccountMode" NOT NULL DEFAULT 'NORMAL',
    "healthEnded"        "AccountHealth" NOT NULL DEFAULT 'HEALTHY',
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AccountDailyMetric_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountDailyMetric_accountId_date_key" ON "AccountDailyMetric"("accountId", "date");
CREATE INDEX "AccountDailyMetric_date_idx" ON "AccountDailyMetric"("date");

-- =====================================================================
-- Allocation
-- =====================================================================

CREATE TABLE "AllocationDecision" (
    "id"                 TEXT NOT NULL,
    "candidateId"        TEXT NOT NULL,
    "policy"             "AllocationPolicy" NOT NULL,
    "setupKey"           TEXT NOT NULL,
    "status"             "AllocationStatus" NOT NULL DEFAULT 'PENDING',
    "selectedAccountIds" JSONB NOT NULL DEFAULT '[]',
    "summary"            TEXT,
    "idempotencyKey"     TEXT NOT NULL,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AllocationDecision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AllocationDecision_idempotencyKey_key" ON "AllocationDecision"("idempotencyKey");
CREATE INDEX "AllocationDecision_candidateId_createdAt_idx" ON "AllocationDecision"("candidateId", "createdAt");
CREATE INDEX "AllocationDecision_status_createdAt_idx" ON "AllocationDecision"("status", "createdAt");

CREATE TABLE "AccountAllocationCandidate" (
    "id"                   TEXT NOT NULL,
    "allocationDecisionId" TEXT NOT NULL,
    "accountId"            TEXT NOT NULL,
    "selected"             BOOLEAN NOT NULL DEFAULT false,
    "totalScore"           DOUBLE PRECISION NOT NULL,
    "componentsJson"       JSONB NOT NULL,
    "reasonCodes"          JSONB NOT NULL DEFAULT '[]',
    "message"              TEXT NOT NULL,
    "proposedRiskUsd"      DOUBLE PRECISION,
    "proposedQuantity"     DOUBLE PRECISION,
    "proposedStopLoss"     DOUBLE PRECISION,
    "proposedTakeProfit"   DOUBLE PRECISION,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccountAllocationCandidate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountAllocationCandidate_allocationDecisionId_accountId_key"
    ON "AccountAllocationCandidate"("allocationDecisionId", "accountId");
CREATE INDEX "AccountAllocationCandidate_accountId_createdAt_idx"
    ON "AccountAllocationCandidate"("accountId", "createdAt");

CREATE TABLE "SetupAllocationPolicy" (
    "id"                    TEXT NOT NULL,
    "setupKey"              TEXT NOT NULL,
    "policy"                "AllocationPolicy" NOT NULL,
    "maxAccounts"           INTEGER NOT NULL DEFAULT 1,
    "requiredTags"          JSONB NOT NULL DEFAULT '[]',
    "excludedTags"          JSONB NOT NULL DEFAULT '[]',
    "allowedPhaseKinds"     JSONB NOT NULL DEFAULT '[]',
    "allowedAccountModes"   JSONB NOT NULL DEFAULT '[]',
    "preferHigherHealth"    BOOLEAN NOT NULL DEFAULT true,
    "preferLowerUtilization" BOOLEAN NOT NULL DEFAULT true,
    "notes"                 TEXT,
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SetupAllocationPolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SetupAllocationPolicy_setupKey_key" ON "SetupAllocationPolicy"("setupKey");

-- =====================================================================
-- Portfolio bucket exposure
-- =====================================================================

CREATE TABLE "PortfolioBucketExposure" (
    "id"                     TEXT NOT NULL,
    "kind"                   "PortfolioBucketKind" NOT NULL,
    "bucketKey"              TEXT NOT NULL,
    "accountId"              TEXT,
    "asOf"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accountCount"           INTEGER NOT NULL DEFAULT 0,
    "openPositionCount"      INTEGER NOT NULL DEFAULT 0,
    "netQuantityLong"        DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netQuantityShort"       DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netDirection"           TEXT NOT NULL DEFAULT 'FLAT',
    "grossRiskUsd"           DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netRiskUsd"             DOUBLE PRECISION NOT NULL DEFAULT 0,
    "aggregateUnrealizedPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "aggregateExposurePct"   DOUBLE PRECISION NOT NULL DEFAULT 0,
    "perAccountJson"         JSONB NOT NULL DEFAULT '[]',
    "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PortfolioBucketExposure_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PortfolioBucketExposure_kind_bucketKey_asOf_idx" ON "PortfolioBucketExposure"("kind", "bucketKey", "asOf");
CREATE INDEX "PortfolioBucketExposure_accountId_asOf_idx" ON "PortfolioBucketExposure"("accountId", "asOf");

-- =====================================================================
-- Bridge health
-- =====================================================================

CREATE TABLE "BridgeHealthSnapshot" (
    "id"                 TEXT NOT NULL,
    "accountId"          TEXT NOT NULL,
    "integrationId"      TEXT NOT NULL,
    "bridgeHost"         TEXT NOT NULL,
    "capturedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status"             "BridgeHealthStatus" NOT NULL,
    "terminalConnected"  BOOLEAN NOT NULL DEFAULT false,
    "brokerConnected"    BOOLEAN NOT NULL DEFAULT false,
    "accountLogin"       TEXT,
    "server"             TEXT,
    "pingMs"             INTEGER,
    "lastOrderAckMs"     INTEGER,
    "lastPositionSyncMs" INTEGER,
    "lastHeartbeatAt"    TIMESTAMP(3) NOT NULL,
    "stalenessSeconds"   INTEGER NOT NULL DEFAULT 0,
    "sdkVersion"         TEXT,
    "notes"              TEXT,
    CONSTRAINT "BridgeHealthSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BridgeHealthSnapshot_accountId_capturedAt_idx" ON "BridgeHealthSnapshot"("accountId", "capturedAt");
CREATE INDEX "BridgeHealthSnapshot_status_capturedAt_idx" ON "BridgeHealthSnapshot"("status", "capturedAt");

-- =====================================================================
-- Supervision
-- =====================================================================

CREATE TABLE "PositionSupervisionTick" (
    "id"                    TEXT NOT NULL,
    "positionId"            TEXT NOT NULL,
    "accountId"             TEXT NOT NULL,
    "asOf"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unrealizedPnlPct"      DOUBLE PRECISION NOT NULL,
    "adversePct"            DOUBLE PRECISION NOT NULL,
    "timeInTradeMinutes"    INTEGER NOT NULL,
    "invalidationTriggered" BOOLEAN NOT NULL DEFAULT false,
    "suggestedAction"       "SupervisionAction" NOT NULL,
    "origin"                "SupervisionActionOrigin" NOT NULL DEFAULT 'DETERMINISTIC',
    "reasonCodes"           JSONB NOT NULL DEFAULT '[]',
    "reasonSummary"         TEXT NOT NULL,
    "aiReviewId"            TEXT,
    "aiAdvisoryVerdict"     "AiVerdict",
    "aiAdvisoryReasoning"   TEXT,
    "executed"              BOOLEAN NOT NULL DEFAULT false,
    "executedAt"            TIMESTAMP(3),
    "errorMessage"          TEXT,
    CONSTRAINT "PositionSupervisionTick_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PositionSupervisionTick_positionId_asOf_idx" ON "PositionSupervisionTick"("positionId", "asOf");
CREATE INDEX "PositionSupervisionTick_accountId_asOf_idx" ON "PositionSupervisionTick"("accountId", "asOf");
CREATE INDEX "PositionSupervisionTick_suggestedAction_asOf_idx" ON "PositionSupervisionTick"("suggestedAction", "asOf");

CREATE TABLE "RuleViolation" (
    "id"           TEXT NOT NULL,
    "accountId"    TEXT NOT NULL,
    "ruleCode"     TEXT NOT NULL,
    "severity"     "Severity" NOT NULL,
    "outcome"      "RuleViolationOutcome" NOT NULL,
    "message"      TEXT NOT NULL,
    "observedJson" JSONB,
    "expectedJson" JSONB,
    "candidateId"  TEXT,
    "decisionId"   TEXT,
    "positionId"   TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt"   TIMESTAMP(3),
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RuleViolation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RuleViolation_accountId_createdAt_idx" ON "RuleViolation"("accountId", "createdAt");
CREATE INDEX "RuleViolation_ruleCode_createdAt_idx" ON "RuleViolation"("ruleCode", "createdAt");

-- =====================================================================
-- AI (advisory)
-- =====================================================================

CREATE TABLE "AiReview" (
    "id"                  TEXT NOT NULL,
    "kind"                "AiReviewKind" NOT NULL,
    "accountId"           TEXT,
    "candidateId"         TEXT,
    "decisionId"          TEXT,
    "positionId"          TEXT,
    "correlationId"       TEXT NOT NULL,
    "model"               TEXT NOT NULL,
    "promptVersion"       TEXT NOT NULL,
    "promptTokens"        INTEGER NOT NULL DEFAULT 0,
    "responseTokens"      INTEGER NOT NULL DEFAULT 0,
    "latencyMs"           INTEGER NOT NULL DEFAULT 0,
    "contextDigest"       TEXT NOT NULL,
    "rawPromptRef"        TEXT,
    "rawResponseRef"      TEXT,
    "verdict"             "AiVerdict" NOT NULL,
    "confidence"          DOUBLE PRECISION NOT NULL,
    "summary"             TEXT NOT NULL,
    "concerns"            JSONB NOT NULL DEFAULT '[]',
    "suggestions"         JSONB NOT NULL DEFAULT '[]',
    "structuredOutput"    JSONB,
    "safetyFiltered"      BOOLEAN NOT NULL DEFAULT false,
    "safetyFilterReasons" JSONB NOT NULL DEFAULT '[]',
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiReview_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiReview_kind_createdAt_idx" ON "AiReview"("kind", "createdAt");
CREATE INDEX "AiReview_accountId_kind_createdAt_idx" ON "AiReview"("accountId", "kind", "createdAt");
CREATE INDEX "AiReview_correlationId_idx" ON "AiReview"("correlationId");

CREATE TABLE "AiLesson" (
    "id"         TEXT NOT NULL,
    "sourceKind" "AiLessonSource" NOT NULL,
    "sourceId"   TEXT,
    "accountId"  TEXT,
    "title"      TEXT NOT NULL,
    "detail"     TEXT NOT NULL,
    "tags"       JSONB NOT NULL DEFAULT '[]',
    "weight"     DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiLesson_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiLesson_active_updatedAt_idx" ON "AiLesson"("active", "updatedAt");
CREATE INDEX "AiLesson_accountId_active_idx" ON "AiLesson"("accountId", "active");

CREATE TABLE "WeeklyReview" (
    "id"              TEXT NOT NULL,
    "accountId"       TEXT,
    "weekStart"       TEXT NOT NULL,
    "weekEnd"         TEXT NOT NULL,
    "kpis"            JSONB NOT NULL DEFAULT '{}',
    "output"          JSONB NOT NULL,
    "aiReviewId"      TEXT,
    "obsidianNoteRef" TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WeeklyReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WeeklyReview_aiReviewId_key" ON "WeeklyReview"("aiReviewId");
CREATE UNIQUE INDEX "WeeklyReview_accountId_weekStart_key" ON "WeeklyReview"("accountId", "weekStart");
CREATE INDEX "WeeklyReview_weekStart_idx" ON "WeeklyReview"("weekStart");

-- =====================================================================
-- Journal exporter
-- =====================================================================

CREATE TABLE "JournalExport" (
    "id"            TEXT NOT NULL,
    "kind"          "JournalNoteKind" NOT NULL,
    "entityId"      TEXT NOT NULL,
    "bucket"        TEXT NOT NULL,
    "accountId"     TEXT,
    "relativePath"  TEXT NOT NULL,
    "contentHash"   TEXT NOT NULL,
    "status"        "JournalExportStatus" NOT NULL DEFAULT 'PENDING',
    "attempts"      INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "lastError"     TEXT,
    "writtenAt"     TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JournalExport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JournalExport_kind_entityId_bucket_key" ON "JournalExport"("kind", "entityId", "bucket");
CREATE INDEX "JournalExport_status_updatedAt_idx" ON "JournalExport"("status", "updatedAt");
CREATE INDEX "JournalExport_accountId_updatedAt_idx" ON "JournalExport"("accountId", "updatedAt");

-- =====================================================================
-- Alter existing tables: nullable accountId + other extensions
-- =====================================================================

ALTER TABLE "AccountSnapshot"
    ADD COLUMN "accountId"              TEXT,
    ADD COLUMN "accountPhaseId"         TEXT,
    ADD COLUMN "accountMode"            "AccountMode",
    ADD COLUMN "accountHealth"          "AccountHealth",
    ADD COLUMN "phaseKind"              "AccountPhaseKind",
    ADD COLUMN "dailyLossUsedUsd"       DOUBLE PRECISION,
    ADD COLUMN "dailyLossUsedPct"       DOUBLE PRECISION,
    ADD COLUMN "dailyLossRemainingUsd"  DOUBLE PRECISION,
    ADD COLUMN "totalLossUsedUsd"       DOUBLE PRECISION,
    ADD COLUMN "totalLossUsedPct"       DOUBLE PRECISION,
    ADD COLUMN "totalLossRemainingUsd"  DOUBLE PRECISION,
    ADD COLUMN "distanceToTargetUsd"    DOUBLE PRECISION,
    ADD COLUMN "distanceToTargetPct"    DOUBLE PRECISION,
    ADD COLUMN "consecutiveLosers"      INTEGER,
    ADD COLUMN "openPositionCount"      INTEGER,
    ADD COLUMN "concurrentRiskUsd"      DOUBLE PRECISION,
    ADD COLUMN "concurrentRiskPct"      DOUBLE PRECISION;

CREATE INDEX "AccountSnapshot_accountId_capturedAt_idx" ON "AccountSnapshot"("accountId", "capturedAt");

ALTER TABLE "ExecutionDecision"
    ADD COLUMN "accountId"              TEXT,
    ADD COLUMN "allocationDecisionId"   TEXT,
    ADD COLUMN "structuredReasons"      JSONB,
    ADD COLUMN "preTradeAiReviewId"     TEXT,
    ADD COLUMN "ruleEvaluations"        JSONB;

CREATE INDEX "ExecutionDecision_accountId_createdAt_idx" ON "ExecutionDecision"("accountId", "createdAt");
CREATE INDEX "ExecutionDecision_allocationDecisionId_idx" ON "ExecutionDecision"("allocationDecisionId");

ALTER TABLE "Order"
    ADD COLUMN "accountId"     TEXT,
    ADD COLUMN "clientOrderId" TEXT,
    ADD COLUMN "riskUsd"       DOUBLE PRECISION;

CREATE UNIQUE INDEX "Order_clientOrderId_key" ON "Order"("clientOrderId");
CREATE INDEX "Order_accountId_status_idx" ON "Order"("accountId", "status");

ALTER TABLE "Position"
    ADD COLUMN "accountId"         TEXT,
    ADD COLUMN "riskUsdAtEntry"    DOUBLE PRECISION,
    ADD COLUMN "currentRiskUsd"    DOUBLE PRECISION,
    ADD COLUMN "lastSupervisedAt"  TIMESTAMP(3);

CREATE INDEX "Position_accountId_status_idx" ON "Position"("accountId", "status");

ALTER TABLE "RiskEvent"
    ADD COLUMN "accountId" TEXT,
    ADD COLUMN "code"      TEXT;

CREATE INDEX "RiskEvent_accountId_createdAt_idx" ON "RiskEvent"("accountId", "createdAt");

-- =====================================================================
-- Foreign keys
-- =====================================================================

ALTER TABLE "Account"
    ADD CONSTRAINT "Account_integrationId_fkey"
        FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "Account_currentPhaseId_fkey"
        FOREIGN KEY ("currentPhaseId") REFERENCES "AccountPhase"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "Account_activeRuleProfileId_fkey"
        FOREIGN KEY ("activeRuleProfileId") REFERENCES "AccountRuleProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AccountPhase"
    ADD CONSTRAINT "AccountPhase_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AccountRuleProfile"
    ADD CONSTRAINT "AccountRuleProfile_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AccountDailyMetric"
    ADD CONSTRAINT "AccountDailyMetric_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AllocationDecision"
    ADD CONSTRAINT "AllocationDecision_candidateId_fkey"
        FOREIGN KEY ("candidateId") REFERENCES "TradeCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AccountAllocationCandidate"
    ADD CONSTRAINT "AccountAllocationCandidate_allocationDecisionId_fkey"
        FOREIGN KEY ("allocationDecisionId") REFERENCES "AllocationDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "AccountAllocationCandidate_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PortfolioBucketExposure"
    ADD CONSTRAINT "PortfolioBucketExposure_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "BridgeHealthSnapshot"
    ADD CONSTRAINT "BridgeHealthSnapshot_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "BridgeHealthSnapshot_integrationId_fkey"
        FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PositionSupervisionTick"
    ADD CONSTRAINT "PositionSupervisionTick_positionId_fkey"
        FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "PositionSupervisionTick_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "PositionSupervisionTick_aiReviewId_fkey"
        FOREIGN KEY ("aiReviewId") REFERENCES "AiReview"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RuleViolation"
    ADD CONSTRAINT "RuleViolation_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "RuleViolation_decisionId_fkey"
        FOREIGN KEY ("decisionId") REFERENCES "ExecutionDecision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AiReview"
    ADD CONSTRAINT "AiReview_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "AiReview_decisionId_fkey"
        FOREIGN KEY ("decisionId") REFERENCES "ExecutionDecision"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "AiReview_positionId_fkey"
        FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AiLesson"
    ADD CONSTRAINT "AiLesson_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WeeklyReview"
    ADD CONSTRAINT "WeeklyReview_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- accountId back-references on existing tables
ALTER TABLE "AccountSnapshot"
    ADD CONSTRAINT "AccountSnapshot_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "AccountSnapshot_accountPhaseId_fkey"
        FOREIGN KEY ("accountPhaseId") REFERENCES "AccountPhase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ExecutionDecision"
    ADD CONSTRAINT "ExecutionDecision_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "ExecutionDecision_allocationDecisionId_fkey"
        FOREIGN KEY ("allocationDecisionId") REFERENCES "AllocationDecision"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "ExecutionDecision_preTradeAiReviewId_fkey"
        FOREIGN KEY ("preTradeAiReviewId") REFERENCES "AiReview"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Order"
    ADD CONSTRAINT "Order_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Position"
    ADD CONSTRAINT "Position_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RiskEvent"
    ADD CONSTRAINT "RiskEvent_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
