import fs from 'fs';
import path from 'path';

import { loadAgentConfig, listAgentIds, resolveAgentDir, resolveAgentClaudeMd, refreshWarRoomRoster } from './agent-config.js';
import { createBot } from './bot.js';
import { checkPendingMigrations } from './migrations.js';
import { ALLOWED_CHAT_ID, activeBotToken, STORE_DIR, PROJECT_ROOT, CLAUDECLAW_CONFIG, GOOGLE_API_KEY, setAgentOverrides, SECURITY_PIN_HASH, IDLE_LOCK_MINUTES, EMERGENCY_KILL_PHRASE, WARROOM_ENABLED, WARROOM_PORT } from './config.js';
import { startDashboard } from './dashboard.js';
import { initDatabase, cleanupOldMissionTasks, insertAuditLog, applyAscFeedbackSchemaIfMissing } from './db.js';
import { initSecurity, setAuditCallback } from './security.js';
import { logger } from './logger.js';
import { cleanupOldUploads } from './media.js';
import { runConsolidation } from './memory-consolidate.js';
import { runDecaySweep } from './memory.js';
import { runWarroomAvatarMigration } from './avatars.js';
import { initOAuthHealthCheck } from './oauth-health.js';
import { initOrchestrator } from './orchestrator.js';
import { initScheduler } from './scheduler.js';
import { setTelegramConnected, setBotInfo } from './state.js';
import { getVenvPython, killProcess } from './platform.js';

// Parse --agent flag
const agentFlagIndex = process.argv.indexOf('--agent');
const AGENT_ID = agentFlagIndex !== -1 ? process.argv[agentFlagIndex + 1] : 'main';

// Export AGENT_ID to env so child processes (schedule-cli, etc.) inherit it
process.env.CLAUDECLAW_AGENT_ID = AGENT_ID;

if (AGENT_ID !== 'main') {
  const agentConfig = loadAgentConfig(AGENT_ID);
  const agentDir = resolveAgentDir(AGENT_ID);
  const claudeMdPath = resolveAgentClaudeMd(AGENT_ID);
  let systemPrompt: string | undefined;
  if (claudeMdPath) {
    try {
      systemPrompt = fs.readFileSync(claudeMdPath, 'utf-8');
    } catch { /* no CLAUDE.md */ }
  }
  setAgentOverrides({
    agentId: AGENT_ID,
    botToken: agentConfig.botToken,
    cwd: agentDir,
    model: agentConfig.model,
    obsidian: agentConfig.obsidian,
    systemPrompt,
    mcpServers: agentConfig.mcpServers,
  });
  logger.info({ agentId: AGENT_ID, name: agentConfig.name }, 'Running as agent');
} else {
  // For main bot: read CLAUDE.md from CLAUDECLAW_CONFIG and inject it as
  // systemPrompt — the same pattern used by sub-agents. Never copy the file
  // into the repo; that defeats the purpose of CLAUDECLAW_CONFIG and risks
  // accidentally committing personal config.
  const externalClaudeMd = path.join(CLAUDECLAW_CONFIG, 'CLAUDE.md');
  if (fs.existsSync(externalClaudeMd)) {
    let systemPrompt: string | undefined;
    try {
      systemPrompt = fs.readFileSync(externalClaudeMd, 'utf-8');
    } catch { /* unreadable */ }
    if (systemPrompt) {
      setAgentOverrides({
        agentId: 'main',
        botToken: activeBotToken,
        cwd: PROJECT_ROOT,
        systemPrompt,
      });
      logger.info({ source: externalClaudeMd }, 'Loaded CLAUDE.md from CLAUDECLAW_CONFIG');
    }
  } else if (!fs.existsSync(path.join(PROJECT_ROOT, 'CLAUDE.md'))) {
    logger.warn(
      'No CLAUDE.md found. Copy CLAUDE.md.example to %s/CLAUDE.md and customize it.',
      CLAUDECLAW_CONFIG,
    );
  }
}

const PID_FILE = path.join(STORE_DIR, `${AGENT_ID === 'main' ? 'claudeclaw' : `agent-${AGENT_ID}`}.pid`);

function showBanner(): void {
  const bannerPath = path.join(PROJECT_ROOT, 'banner.txt');
  try {
    const banner = fs.readFileSync(bannerPath, 'utf-8');
    console.log('\n' + banner);
  } catch {
    console.log('\n  ClaudeClaw\n');
  }
}

function acquireLock(): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  try {
    if (fs.existsSync(PID_FILE)) {
      const old = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (!isNaN(old) && old !== process.pid) {
        killProcess(old);
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); } catch { /* ok */ }
      }
    }
  } catch { /* ignore */ }
  fs.writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 });
}

function releaseLock(): void {
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

async function main(): Promise<void> {
  
  checkPendingMigrations(PROJECT_ROOT);

  if (AGENT_ID === 'main') {
    showBanner();
  }

  if (!activeBotToken) {
    if (AGENT_ID === 'main') {
      logger.error('Bot token is not set. Run npm run setup to configure it.');
    } else {
      logger.error({ agentId: AGENT_ID }, `Configuration for agent "${AGENT_ID}" is broken: bot token not set. Check .env or re-run npm run agent:create.`);
    }
    process.exit(1);
  }

  acquireLock();

  try {
    initDatabase();
  } catch (err: any) {
    logger.error('Database initialization failed: %s', err?.message || err);
    if (err?.message?.includes('DB_ENCRYPTION_KEY')) {
      logger.error('Fix: add DB_ENCRYPTION_KEY to .env. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    }
    process.exit(1);
  }
  // Apply skill-owned schemas after the core DB is up. Idempotent; safe to
  // call on every boot. Skipped silently if the migration file is absent.
  try {
    applyAscFeedbackSchemaIfMissing();
  } catch (err: any) {
    logger.error('asc_feedback schema apply failed: %s', err?.message || err);
  }
  logger.info('Database ready');

  // Initialize security (PIN lock, kill phrase, destructive confirmation, audit)
  initSecurity({
    pinHash: SECURITY_PIN_HASH || undefined,
    idleLockMinutes: IDLE_LOCK_MINUTES,
    killPhrase: EMERGENCY_KILL_PHRASE || undefined,
  });
  setAuditCallback((entry) => {
    insertAuditLog(entry.agentId, entry.chatId, entry.action, entry.detail, entry.blocked);
  });

  initOrchestrator();

  // Decay and consolidation run ONLY in the main process to prevent
  // multi-process over-decay (5x decay on simultaneous restart) and
  // duplicate consolidation records from overlapping memory batches.
  if (AGENT_ID === 'main') {
    runDecaySweep();
    cleanupOldMissionTasks(7);
    setInterval(() => { runDecaySweep(); cleanupOldMissionTasks(7); }, 24 * 60 * 60 * 1000);

    // One-time bundled→mutable avatar migration. After this lands, any
    // previously user-uploaded main avatar that we wrote into the
    // bundled namespace gets copied into STORE_DIR/avatars/main.png so
    // the new resolver serves it as the mutable source-of-truth.
    runWarroomAvatarMigration();

    // Memory consolidation: find patterns across recent memories every 30 minutes
    if (ALLOWED_CHAT_ID && GOOGLE_API_KEY) {
      // Delay first consolidation 2 minutes after startup to let things settle
      setTimeout(() => {
        void runConsolidation(ALLOWED_CHAT_ID).catch((err) =>
          logger.error({ err }, 'Initial consolidation failed'),
        );
      }, 2 * 60 * 1000);
      setInterval(() => {
        void runConsolidation(ALLOWED_CHAT_ID).catch((err) =>
          logger.error({ err }, 'Periodic consolidation failed'),
        );
      }, 30 * 60 * 1000);
      logger.info('Memory consolidation enabled (every 30 min)');
    }
  } else {
    logger.info({ agentId: AGENT_ID }, 'Skipping decay/consolidation (main process owns these)');
  }

  cleanupOldUploads();

  const bot = createBot();

  // Dashboard only runs in the main bot process
  if (AGENT_ID === 'main') {
    startDashboard(bot.api);

    // War Room voice server (auto-start if enabled, with auto-respawn)
    if (WARROOM_ENABLED) {
      const { spawn } = await import('child_process');
      const venvPython = getVenvPython(path.join(PROJECT_ROOT, 'warroom', '.venv'));
      const serverScript = path.join(PROJECT_ROOT, 'warroom', 'server.py');

      // Write agent roster so the Python voice stack can discover agents.
      // Shared helper so agent-create can call it too on new/delete.
      refreshWarRoomRoster();

      if (fs.existsSync(venvPython) && fs.existsSync(serverScript)) {
        // Pre-flight: verify Python dependencies are actually installed
        const { spawnSync } = await import('child_process');
        const depCheck = spawnSync(venvPython, ['-c', 'import pipecat'], { stdio: 'pipe', timeout: 10000 });
        if (depCheck.status !== 0) {
          const msg = 'War Room Python dependencies not installed. Run:\n\n'
            + 'source warroom/.venv/bin/activate\n'
            + 'pip install -r warroom/requirements.txt\n\n'
            + 'Then restart the bot.';
          logger.error(msg);
          if (ALLOWED_CHAT_ID) {
            bot.api.sendMessage(ALLOWED_CHAT_ID, `War Room could not start.\n\n${msg}`).catch(() => {});
          }
        } else {
        // Dedicated log file for the warroom subprocess
        const warroomLogPath = '/tmp/warroom-debug.log';
        let warroomLogFd: number | null = null;
        try {
          warroomLogFd = fs.openSync(warroomLogPath, 'a');
        } catch (err) {
          logger.warn({ err, warroomLogPath }, 'Could not open warroom log');
        }

        const MAX_CRASH_RESPAWNS = 3;
        // Time a process must stay alive without crashing before we treat
        // its crash counter as "recovered" and reset it. The python server
        // prints "ready" before it actually binds the WS transport, so a
        // bind-time failure could print ready then crash in the same
        // second. Resetting on first stdout chunk let that loop forever.
        const STABLE_UPTIME_MS = 20_000;
        let respawnAttempts = 0;
        let shuttingDown = false;
        let currentProc: ReturnType<typeof spawn> | null = null;

        const spawnWarroom = (): void => {
          if (shuttingDown) return;
          const proc = spawn(venvPython, [serverScript], {
            cwd: PROJECT_ROOT,
            env: { ...process.env, WARROOM_PORT: String(WARROOM_PORT) },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          currentProc = proc;

          // Schedule the crash-counter reset based on *uptime*, not the
          // readiness line. Cleared in the exit handler if the process
          // dies before reaching STABLE_UPTIME_MS.
          const stableResetHandle = setTimeout(() => {
            respawnAttempts = 0;
          }, STABLE_UPTIME_MS);

          proc.stdout.once('data', (data: Buffer) => {
            try {
              const info = JSON.parse(data.toString().trim());
              logger.info({ port: WARROOM_PORT, ws_url: info.ws_url, pid: proc.pid }, 'War Room server started');
            } catch {
              logger.info({ port: WARROOM_PORT, pid: proc.pid }, 'War Room server started');
            }
          });

          // Forward stdout+stderr into the dedicated log file.
          if (warroomLogFd !== null) {
            const write = (buf: Buffer) => { try { fs.writeSync(warroomLogFd!, buf); } catch { /* ok */ } };
            proc.stdout.on('data', write);
            proc.stderr.on('data', write);
          }

          proc.on('exit', (code, signal) => {
            clearTimeout(stableResetHandle);
            if (shuttingDown) return;
            const wasIntentional = signal === 'SIGTERM' || signal === 'SIGKILL' || signal === 'SIGINT';
            logger.warn({ code, signal, pid: proc.pid, intentional: wasIntentional }, 'War Room server exited');
            let delayMs: number;
            if (wasIntentional) {
              delayMs = 300;
              respawnAttempts = 0;
            } else {
              respawnAttempts += 1;
              if (respawnAttempts > MAX_CRASH_RESPAWNS) {
                logger.error(`War Room crashed ${MAX_CRASH_RESPAWNS} times. Giving up. Check /tmp/warroom-debug.log for errors.`);
                if (ALLOWED_CHAT_ID) {
                  bot.api.sendMessage(ALLOWED_CHAT_ID, `War Room crashed ${MAX_CRASH_RESPAWNS} times and has been disabled.\n\nCheck /tmp/warroom-debug.log, fix the issue, and restart the bot.`).catch(() => {});
                }
                return;
              }
              delayMs = Math.min(30000, 500 * 2 ** Math.min(respawnAttempts, 6));
            }
            logger.info({ delayMs, attempt: respawnAttempts }, 'Respawning War Room server');
            setTimeout(spawnWarroom, delayMs);
          });
        };

        spawnWarroom();

        // Clean up on main process exit.
        const shutdownWarroom = () => {
          shuttingDown = true;
          try { currentProc?.kill(); } catch { /* ok */ }
          if (warroomLogFd !== null) { try { fs.closeSync(warroomLogFd); } catch { /* ok */ } }
        };
        process.on('exit', shutdownWarroom);
        process.on('SIGTERM', shutdownWarroom);
        process.on('SIGINT', shutdownWarroom);
        } // end dep check else
      } else {
        const missingVenv = !fs.existsSync(venvPython);
        const missingScript = !fs.existsSync(serverScript);
        const hint = missingVenv
          ? 'Python venv not found. Run:\n\npython3 -m venv warroom/.venv\nsource warroom/.venv/bin/activate\npip install -r warroom/requirements.txt'
          : 'warroom/server.py not found. Make sure the warroom/ directory exists.';
        logger.warn('War Room enabled but cannot start: %s', hint);
        if (ALLOWED_CHAT_ID) {
          bot.api.sendMessage(ALLOWED_CHAT_ID, `War Room is enabled but could not start.\n\n${hint}`).catch(() => {});
        }
      }
    }

    // App Store Connect feedback poll. Runs every 30 min in the main process,
    // first run after a 2 min settle delay. Three consecutive failures pause
    // polling for the rest of this process lifetime and send one Telegram
    // alert. The poller itself never throws — its return shape carries an
    // errors[] array. We treat a non-empty errors[] OR a thrown exception as
    // a failure for the strike counter.
    if (ALLOWED_CHAT_ID) {
      // Dynamic import via a runtime-computed specifier. Bypasses TS rootDir
      // checking because the path is not a string literal at compile time.
      // The skill lives outside src/ on purpose (skill manifest convention).
      const ascSkillPath = '../skills/appstoreconnect/index.js';
      const ascSkill = (await import(ascSkillPath)) as {
        pollAscNow: (env: NodeJS.ProcessEnv, dbPath: string) => Promise<{
          inserted: number;
          skipped: number;
          errors: unknown[];
        }>;
      };
      const { pollAscNow } = ascSkill;
      // ClaudeClaw's readEnvFile is the source of truth for .env values —
      // process.env is intentionally not populated to keep secrets out of
      // child processes. Read the ASC vars on each fire so a manual .env
      // edit (e.g. rotated key) takes effect on the next interval without
      // a full restart.
      const { readEnvFile } = await import('./env.js');
      let ascConsecutiveFailures = 0;
      let ascPaused = false;
      const ascDbPath = path.join(STORE_DIR, 'claudeclaw.db');
      const ASC_FAILURE_THRESHOLD = 3;
      const ASC_INTERVAL_MS = 30 * 60 * 1000;
      const ASC_INITIAL_DELAY_MS = 2 * 60 * 1000;

      const runAscPoll = async (): Promise<void> => {
        if (ascPaused) return;
        try {
          const ascEnv = readEnvFile([
            'ANTHROPIC_API_KEY',
            'ASC_ISSUER_ID',
            'ASC_KEY_ID',
            'ASC_PRIVATE_KEY_PATH',
            'ASC_APP_ID',
            'GITHUB_OWNER',
            'GITHUB_REPO',
          ]);
          const result = await pollAscNow(ascEnv as NodeJS.ProcessEnv, ascDbPath);
          if (result.errors.length === 0) {
            ascConsecutiveFailures = 0;
            logger.info(
              { inserted: result.inserted, skipped: result.skipped },
              'ASC poll completed',
            );
          } else {
            ascConsecutiveFailures++;
            logger.warn(
              { errors: result.errors, consecutiveFailures: ascConsecutiveFailures },
              'ASC poll completed with errors',
            );
          }
        } catch (err) {
          ascConsecutiveFailures++;
          logger.error(
            { err, consecutiveFailures: ascConsecutiveFailures },
            'ASC poll threw',
          );
        }
        if (ascConsecutiveFailures >= ASC_FAILURE_THRESHOLD && !ascPaused) {
          ascPaused = true;
          await bot.api
            .sendMessage(
              ALLOWED_CHAT_ID,
              `App Store Connect poll failed ${ASC_FAILURE_THRESHOLD} times in a row. Polling paused until the bot is restarted. Check /tmp/claudeclaw.err for details.`,
            )
            .catch((err: unknown) => logger.error({ err }, 'Failed to send ASC pause alert'));
        }
      };

      setTimeout(() => void runAscPoll(), ASC_INITIAL_DELAY_MS);
      setInterval(() => void runAscPoll(), ASC_INTERVAL_MS);
      logger.info('App Store Connect poll enabled (every 30 min)');

      // Comms-agent draft cron. Runs every 5 min in the main process. First
      // tick fires 30s after startup so the ASC poll's initial-delay window
      // has time to finish (the comms cron only ever drafts rows the ASC
      // poll has already inserted, so racing the first ASC fire is wasted
      // work). Three consecutive failures pause drafting for the rest of
      // this process lifetime and send one Telegram alert. If
      // ANTHROPIC_API_KEY is unset, the cron is skipped entirely (logged
      // once) — drafting is impossible without it. The runAgent is rebuilt
      // when the key changes between ticks so a manual .env rotation takes
      // effect without a restart.
      const initialAnthropicEnv = readEnvFile(['ANTHROPIC_API_KEY']);
      if (!initialAnthropicEnv.ANTHROPIC_API_KEY) {
        logger.warn(
          'Comms-agent draft cron disabled: ANTHROPIC_API_KEY not set in .env',
        );
      } else {
        const commsSkillPath = '../skills/comms-agent/index.js';
        const commsSkill = (await import(commsSkillPath)) as {
          processPendingFeedback: (opts: {
            dbPath: string;
            runAgent: (p: string) => Promise<string>;
          }) => Promise<{
            drafted: number;
            failed: number;
            errors: Array<{ feedbackId: number; message: string }>;
          }>;
          makeRunAgent: (opts: {
            apiKey: string;
            model?: string;
          }) => (prompt: string) => Promise<string>;
        };
        const { processPendingFeedback, makeRunAgent } = commsSkill;

        let commsConsecutiveFailures = 0;
        let commsPaused = false;
        let lastApiKey: string = initialAnthropicEnv.ANTHROPIC_API_KEY;
        let runAgent = makeRunAgent({ apiKey: lastApiKey });
        const commsDbPath = path.join(STORE_DIR, 'claudeclaw.db');
        const COMMS_FAILURE_THRESHOLD = 3;
        const COMMS_INTERVAL_MS = 5 * 60 * 1000;
        const COMMS_INITIAL_DELAY_MS = 30 * 1000;

        const runCommsTick = async (): Promise<void> => {
          if (commsPaused) return;
          try {
            const env = readEnvFile(['ANTHROPIC_API_KEY']);
            const currentKey = env.ANTHROPIC_API_KEY;
            if (!currentKey) {
              commsConsecutiveFailures++;
              logger.warn(
                { consecutiveFailures: commsConsecutiveFailures },
                'Comms-agent tick: ANTHROPIC_API_KEY no longer present',
              );
            } else {
              if (currentKey !== lastApiKey) {
                lastApiKey = currentKey;
                runAgent = makeRunAgent({ apiKey: currentKey });
                logger.info('Comms-agent runAgent rebuilt after API key rotation');
              }
              const result = await processPendingFeedback({ dbPath: commsDbPath, runAgent });
              if (result.failed > 0) {
                commsConsecutiveFailures++;
                logger.warn(
                  {
                    drafted: result.drafted,
                    failed: result.failed,
                    errors: result.errors,
                    consecutiveFailures: commsConsecutiveFailures,
                  },
                  'Comms-agent tick completed with failures',
                );
              } else {
                if (result.drafted > 0) {
                  commsConsecutiveFailures = 0;
                  logger.info({ drafted: result.drafted }, 'Comms-agent drafted');
                } else {
                  // Clean idle tick: nothing to do, no errors. Reset the
                  // strike counter (a previous transient failure shouldn't
                  // accumulate across long quiet periods) and log at debug.
                  commsConsecutiveFailures = 0;
                  logger.debug('Comms-agent tick idle (no pending rows)');
                }
              }
            }
          } catch (err) {
            commsConsecutiveFailures++;
            logger.error(
              { err, consecutiveFailures: commsConsecutiveFailures },
              'Comms-agent tick threw',
            );
          }
          if (commsConsecutiveFailures >= COMMS_FAILURE_THRESHOLD && !commsPaused) {
            commsPaused = true;
            await bot.api
              .sendMessage(
                ALLOWED_CHAT_ID,
                `Comms-agent draft cron failed ${COMMS_FAILURE_THRESHOLD} times in a row. Drafting paused until the bot is restarted. Check /tmp/claudeclaw.err for details.`,
              )
              .catch((err: unknown) =>
                logger.error({ err }, 'Failed to send comms-agent pause alert'),
              );
          }
        };

        setTimeout(() => void runCommsTick(), COMMS_INITIAL_DELAY_MS);
        setInterval(() => void runCommsTick(), COMMS_INTERVAL_MS);
        logger.info('Comms-agent draft cron enabled (every 5 min)');
      }
    }
  }

  if (ALLOWED_CHAT_ID) {
    initScheduler(
      async (text) => {
        // Split long messages to respect Telegram's 4096 char limit.
        // The scheduler's splitMessage handles chunking, but the sender
        // callback is also called directly for status messages which may exceed the limit.
        const { splitMessage } = await import('./bot.js');
        for (const chunk of splitMessage(text)) {
          await bot.api.sendMessage(ALLOWED_CHAT_ID, chunk, { parse_mode: 'HTML' }).catch((err) =>
            logger.error({ err }, 'Scheduler failed to send message'),
          );
        }
      },
      AGENT_ID,
    );

    // Proactive OAuth health monitoring — alerts via Telegram before the
    // Claude CLI token expires. OPT-IN as of 2026-04-10: users were getting
    // spammed with "Expiring soon" alerts on fresh installs (reported by
    // Benjamin Elkrieff in Discord), and people who don't monitor their
    // phone can't re-auth in time anyway. Enable only if you actually want
    // the alerts by setting OAUTH_HEALTH_ENABLED=true in .env.
    const oauthHealthEnv = (await import('./env.js')).readEnvFile(['OAUTH_HEALTH_ENABLED']);
    if ((oauthHealthEnv.OAUTH_HEALTH_ENABLED || '').trim().toLowerCase() === 'true') {
      initOAuthHealthCheck(async (text) => {
        const { splitMessage } = await import('./bot.js');
        for (const chunk of splitMessage(text)) {
          await bot.api.sendMessage(ALLOWED_CHAT_ID, chunk, { parse_mode: 'HTML' }).catch((err) =>
            logger.error({ err }, 'OAuth health alert failed'),
          );
        }
      });
    } else {
      logger.info('OAuth health check disabled (set OAUTH_HEALTH_ENABLED=true in .env to enable)');
    }
  } else {
    logger.warn('ALLOWED_CHAT_ID not set — scheduler disabled (no destination for results)');
  }

  const shutdown = async () => {
    logger.info('Shutting down...');
    setTelegramConnected(false);
    releaseLock();
    await bot.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  logger.info({ agentId: AGENT_ID }, 'Starting ClaudeClaw...');

  // Clear any existing webhook so polling works cleanly (e.g., if token was
  // previously used with a webhook-based bot or another ClaudeClaw instance).
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: false });
  } catch (err) {
    logger.warn({ err }, 'Could not clear webhook (non-fatal)');
  }

  await bot.start({
    onStart: (botInfo) => {
      setTelegramConnected(true);
      setBotInfo(botInfo.username ?? '', botInfo.first_name ?? 'ClaudeClaw');
      logger.info({ username: botInfo.username }, 'ClaudeClaw is running');
      if (AGENT_ID === 'main') {
        console.log(`\n  ClaudeClaw online: @${botInfo.username}`);
        if (!ALLOWED_CHAT_ID) {
          console.log(`  Send /chatid to get your chat ID for ALLOWED_CHAT_ID`);
        }
        console.log();
      } else {
        console.log(`\n  ClaudeClaw agent [${AGENT_ID}] online: @${botInfo.username}\n`);
      }
    },
  });
}

main().catch((err: unknown) => {
  logger.error({ err }, 'Fatal error');
  releaseLock();
  process.exit(1);
});
