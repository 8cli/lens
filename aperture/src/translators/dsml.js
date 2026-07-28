// --- DSML Tool Call Normalization -------------------------

import { uid } from "../helpers.js";
import { DSML_CONTENT_MAX } from "../config.js";

/**
 * Detect and convert Console Go DSML tool calls to standard OpenAI tool_calls format.
 *
 * Console Go sometimes returns tool calls as DSML XML embedded in the content text
 * (with finish_reason: "stop") instead of standard message.tool_calls format.
 * This function detects this pattern and normalizes it.
 */
export function normalizeDsmlToolCalls(responseBody) {
  if (!responseBody?.choices?.[0]?.message) return responseBody;
  const choice = responseBody.choices[0];
  const msg = choice.message;
  const content = msg.content || "";

  // Detect DSML-style tool calls by checking for invoke name pattern
  // DSML format: invoke name="funcName" ... parameter name="..." values
  // Cap content length before regex to avoid ReDoS on malicious upstream responses
  if (content.length > DSML_CONTENT_MAX) return responseBody;
  if (!/invoke\s+name\s*=\s*"/i.test(content)) return responseBody;

  const toolCalls = [];

  // Extract all invoke blocks and their parameters
  const invokeRegex = /invoke\s+name\s*=\s*"([^"]+)"([\s\S]*?)(?=invoke\s+name\s*=\s*"|$)/gi;
  let invokeMatch;
  while ((invokeMatch = invokeRegex.exec(content)) !== null) {
    const fnName = invokeMatch[1];
    const blockContent = invokeMatch[2];

    const args = {};
    const paramRegex = /parameter\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/parameter/gi;
    let pMatch;
    while ((pMatch = paramRegex.exec(blockContent)) !== null) {
      if (pMatch[1]) args[pMatch[1]] = pMatch[2].trim() || "";
    }

    if (Object.keys(args).length > 0) {
      toolCalls.push({
        index: toolCalls.length,
        id: `call_dsml_${uid("")}`,
        type: "function",
        function: {
          name: fnName,
          arguments: JSON.stringify(args),
        },
      });
    }
  }

  if (toolCalls.length === 0) return responseBody;

  // Preserve any non-DSML text from the original content
  // Remove complete DSML invoke blocks including delimiters
  let prose = content.replace(/<invoke\s+name\s*=\s*"[^"]*"[\s\S]*?<\/invoke>/gi, "").trim();
  if (prose) {
    msg.content = prose; // Keep non-DSML prose as content
  } else {
    msg.content = ""; // Pure DSML content replaced with empty
  }
  msg.tool_calls = toolCalls;
  if (choice.finish_reason === "stop" || choice.finish_reason === "length") {
    choice.finish_reason = "tool_calls";
  }

  return responseBody;
}
