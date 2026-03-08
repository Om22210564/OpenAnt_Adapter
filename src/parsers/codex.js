'use strict';

const fs = require('fs');
const {
  makeSession, makeTurn,
  makeTextBlock, makeReasoningBlock,
  makeToolCallBlock, makeToolResultBlock,
  randomUuid,
} = require('../schema');

/**
 * Extract summary text from Codex reasoning summary array.
 * @param {Array} summary
 * @returns {string}
 */
function extractSummaryText(summary) {
  if (!Array.isArray(summary)) return '';
  return summary
    .filter(s => s && s.type === 'summary_text')
    .map(s => s.text || '')
    .join(' ')
    .trim();
}

/**
 * Extract text from Codex message content array.
 * @param {Array} content
 * @returns {string}
 */
function extractMessageText(content) {
  if (!Array.isArray(content)) return String(content || '');
  return content
    .filter(c => c && (c.type === 'input_text' || c.type === 'output_text'))
    .map(c => c.text || '')
    .join('\n')
    .trim();
}

/**
 * Parse a Codex rollout JSONL file into a CanonicalSession.
 * @param {string} filePath
 * @returns {{ session: Object, warnings: string[] }}
 */
function parseCodexSession(filePath) {
  const warnings = [];
  let rawContent;
  try {
    rawContent = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new Error('Cannot read file: ' + filePath + ' (' + e.message + ')');
  }

  const rawLines = rawContent.split('\n').filter(l => l.trim());
  let failedLines = 0;
  const records = [];

  for (let i = 0; i < rawLines.length; i++) {
    try {
      records.push({ lineNum: i + 1, obj: JSON.parse(rawLines[i]) });
    } catch (e) {
      failedLines++;
      warnings.push('Line ' + (i + 1) + ': JSON parse error — ' + e.message);
    }
  }

  if (failedLines > 0 && failedLines / rawLines.length > 0.2) {
    warnings.push('WARNING: more than 20% of lines failed to parse (' + failedLines + '/' + rawLines.length + ')');
  }

  // Build session from session_meta
  const session = makeSession({ source: 'codex', meta: { filePath } });

  // State machine
  let currentAssistantTurn = null;  // pending assistant CanonicalTurn
  let pendingToolCalls = new Map(); // call_id → tool_call block (for matching outputs)
  let turnIndex = 0;

  function flushAssistantTurn() {
    if (currentAssistantTurn && currentAssistantTurn.blocks.length > 0) {
      session.turns.push(currentAssistantTurn);
      turnIndex++;
    }
    currentAssistantTurn = null;
    pendingToolCalls = new Map();
  }

  function ensureAssistantTurn(meta) {
    if (!currentAssistantTurn) {
      currentAssistantTurn = makeTurn({
        id: randomUuid(),
        role: 'assistant',
        timestamp: new Date().toISOString(),
        meta: meta || {},
      });
    }
    return currentAssistantTurn;
  }

  for (const { lineNum, obj } of records) {
    const type = obj.type;
    const payload = obj.payload || {};
    const ts = obj.timestamp || new Date().toISOString();

    if (type === 'session_meta') {
      session.id = payload.id || session.id || randomUuid();
      session.cwd = payload.cwd || '';
      session.timestamp = payload.timestamp || ts;
      session.cliVersion = payload.cli_version || null;
      session.modelProvider = payload.model_provider || null;
      if (payload.base_instructions && payload.base_instructions.text) {
        session.baseInstructions = payload.base_instructions.text;
      }
      session.meta.originator = payload.originator || null;
      session.meta.source = payload.source || null;
      continue;
    }

    if (type === 'turn_context') {
      // A turn_context signals a new assistant turn boundary — flush pending
      flushAssistantTurn();
      // Start new assistant turn
      const tc = payload;
      currentAssistantTurn = makeTurn({
        id: tc.turn_id || randomUuid(),
        role: 'assistant',
        timestamp: ts,
        meta: {
          approval_policy: tc.approval_policy || null,
          sandbox_policy: tc.sandbox_policy || null,
          model: tc.model || null,
          collaboration_mode: tc.collaboration_mode || null,
        },
      });
      // Update session model from first turn_context that has one
      if (tc.model && !session.model) {
        session.model = tc.model;
      }
      continue;
    }

    if (type === 'event_msg') {
      // Skip all event_msg records
      continue;
    }

    if (type === 'response_item') {
      const pt = payload.type;

      if (pt === 'message') {
        const role = payload.role;
        const text = extractMessageText(payload.content);

        if (role === 'developer') {
          // Update base instructions (system prompt updates)
          if (text) session.baseInstructions = text;
          continue;
        }

        if (role === 'user') {
          // Flush any pending assistant turn, then emit user turn
          flushAssistantTurn();
          const userTurn = makeTurn({
            id: randomUuid(),
            role: 'user',
            timestamp: ts,
            blocks: [makeTextBlock(text)],
          });
          session.turns.push(userTurn);
          turnIndex++;
          continue;
        }

        if (role === 'assistant') {
          // Assistant text message
          const turn = ensureAssistantTurn();
          turn.timestamp = ts;
          if (text) turn.blocks.push(makeTextBlock(text));
          continue;
        }
      }

      if (pt === 'reasoning') {
        const summaryText = extractSummaryText(payload.summary);
        const encryptedContent = payload.encrypted_content || null;
        const turn = ensureAssistantTurn();
        turn.timestamp = ts;
        turn.blocks.push(makeReasoningBlock(summaryText, encryptedContent));
        continue;
      }

      if (pt === 'function_call') {
        const turn = ensureAssistantTurn();
        turn.timestamp = ts;
        // arguments is a JSON string from Codex — parse to object for Claude tool_use compatibility
        let input = {};
        if (payload.arguments !== undefined) {
          if (typeof payload.arguments === 'string') {
            try { input = JSON.parse(payload.arguments); } catch (e) { input = { _raw: payload.arguments }; }
          } else {
            input = payload.arguments;
          }
        }
        const block = makeToolCallBlock(payload.call_id, payload.name, 'standard', input);
        turn.blocks.push(block);
        pendingToolCalls.set(payload.call_id, block);
        continue;
      }

      if (pt === 'function_call_output') {
        const turn = ensureAssistantTurn();
        turn.timestamp = ts;
        const outputStr = typeof payload.output === 'string'
          ? payload.output
          : JSON.stringify(payload.output);
        const isError = Boolean(payload.error);
        turn.blocks.push(makeToolResultBlock(payload.call_id, outputStr, isError));
        continue;
      }

      if (pt === 'custom_tool_call') {
        const turn = ensureAssistantTurn();
        turn.timestamp = ts;
        // input is a raw string for custom tools (e.g. apply_patch) — wrap in object for Claude compatibility
        let input = {};
        if (payload.input !== undefined) {
          input = typeof payload.input === 'string'
            ? { input: payload.input }
            : payload.input;
        }
        const block = makeToolCallBlock(payload.call_id, payload.name, 'custom', input);
        turn.blocks.push(block);
        pendingToolCalls.set(payload.call_id, block);
        continue;
      }

      if (pt === 'custom_tool_call_output') {
        const turn = ensureAssistantTurn();
        turn.timestamp = ts;
        const outputStr = typeof payload.output === 'string'
          ? payload.output
          : JSON.stringify(payload.output);
        const isError = Boolean(payload.error);
        turn.blocks.push(makeToolResultBlock(payload.call_id, outputStr, isError));
        continue;
      }

      if (pt === 'web_search_call') {
        // Skip
        continue;
      }

      // Unknown response_item types — skip with warning
      warnings.push('Line ' + lineNum + ': Unknown response_item type: ' + pt);
    }
  }

  // Flush any remaining assistant turn
  flushAssistantTurn();

  return { session, warnings };
}

module.exports = { parseCodexSession };
