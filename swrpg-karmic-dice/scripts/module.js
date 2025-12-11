
// swrpg-karmic-dice/scripts/module.js

const MODULE_ID = "swrpg-karmic-dice";

/* ------------------------------------------------------------------------- */
/* Logging helpers                                                           */
/* ------------------------------------------------------------------------- */

function log(...args) {
  console.log(`${MODULE_ID} |`, ...args);
}

function warn(...args) {
  console.warn(`${MODULE_ID} |`, ...args);
}

function error(...args) {
  console.error(`${MODULE_ID} |`, ...args);
}

/* ------------------------------------------------------------------------- */
/* Simple in-memory karma tracking (per die type)                            */
/* ------------------------------------------------------------------------- */

/**
 * karmaState[denom] = {
 *   faces: number,
 *   rolls: number,
 *   counts: { 1: n, 2: n, ... }
 * }
 */
const karmaState = {};

/**
 * Record that a particular die face was rolled.
 */
function recordFace(denom, face, faces) {
  if (!denom || typeof face !== "number") return;
  if (!karmaState[denom]) {
    const counts = {};
    for (let i = 1; i <= (faces || 12); i += 1) counts[i] = 0;
    karmaState[denom] = { faces: faces || 12, rolls: 0, counts };
  }

  const entry = karmaState[denom];
  entry.rolls += 1;
  if (entry.counts[face] === undefined) entry.counts[face] = 0;
  entry.counts[face] += 1;
}

/**
 * CORE HOOK POINT for all future karma logic.
 *
 * For now this is a NO-OP that simply returns the original face.
 * Later you can:
 *  - Look at karmaState[denom]
 *  - Decide whether to bump the face up or down
 *  - Return a new face index (1..faces)
 *
 * @param {string} denom  Die denomination: a,b,p,d,c,s,f
 * @param {number} face   Original face index (1..faces)
 * @param {number} faces  Total faces on this die
 * @returns {number}      Adjusted face index (1..faces)
 */
function applyKarmaFace(denom, face, faces) {
  // ---- PLACEHOLDER IMPLEMENTATION ----
  // This is where you’ll eventually implement the “too many blanks” etc logic.
  // For now, do not actually change the result.
  return face;
}

/* ------------------------------------------------------------------------- */
/* Mapping die denomination -> CONFIG.FFG result tables                      */
/* ------------------------------------------------------------------------- */

function getFfgResultTableForDenom(denom) {
  const FFG = CONFIG.FFG || {};
  const map = {
    // positive
    a: FFG.ABILITY_RESULTS,
    b: FFG.BOOST_RESULTS,
    p: FFG.PROFICIENCY_RESULTS,
    // negative
    d: FFG.DIFFICULTY_RESULTS,
    c: FFG.CHALLENGE_RESULTS,
    s: FFG.SETBACK_RESULTS,
    // force
    f: FFG.FORCE_RESULTS
  };
  return map[denom] || null;
}

function describeDenom(denom) {
  switch (denom) {
    case "b": return "Boost";
    case "s": return "Setback";
    case "a": return "Ability";
    case "d": return "Difficulty";
    case "p": return "Proficiency";
    case "c": return "Challenge";
    case "f": return "Force";
    default: return denom || "Unknown";
  }
}

/* ------------------------------------------------------------------------- */
/* Patching the FFG dice term classes                                        */
/* ------------------------------------------------------------------------- */

/**
 * Wrap the async roll() method of a FFG DiceTerm subclass so we can
 * record and optionally adjust the face before it’s turned into FFG symbols.
 */
function installKarmicPatchOnTerm(TermClass) {
  if (!TermClass || typeof TermClass.prototype?.roll !== "function") return;

  const denom = TermClass.DENOMINATION || TermClass.denomination || "?";

  // Avoid double-wrapping
  if (TermClass.prototype._karmicPatched) return;

  const originalRoll = TermClass.prototype.roll;

  TermClass.prototype.roll = async function karmicRoll(options = {}) {
    const result = await originalRoll.call(this, options);

    try {
      const faces = this.faces || 12;
      const originalFace = result.result;

      // Track statistics
      recordFace(denom, originalFace, faces);

      // Decide whether to adjust
      const adjustedFace = applyKarmaFace(denom, originalFace, faces);

      if (typeof adjustedFace === "number" && adjustedFace !== originalFace) {
        result.result = adjustedFace;

        const table = getFfgResultTableForDenom(denom);
        if (table && table[adjustedFace]) {
          result.ffg = table[adjustedFace];
        }

        result.karmic = {
          dieType: denom,
          originalResult: originalFace,
          adjustedResult: adjustedFace
        };
      }
    } catch (e) {
      error("Error applying karmic adjustment to die roll", e);
    }

    return result;
  };

  TermClass.prototype._karmicPatched = true;
  log(`Installed karmic patch on die term: ${TermClass.name} (denom=${denom})`);
}

/**
 * Install patches on all FFG dice terms exposed by the system.
 */
function installKarmicPatches() {
  if (game.system.id !== "starwarsffg") {
    warn("Not running in Star Wars FFG system; Karmic Dice will be idle.");
    return;
  }

  if (!game.ffg?.diceterms || !Array.isArray(game.ffg.diceterms)) {
    warn("game.ffg.diceterms not found; cannot patch FFG dice terms.");
    return;
  }

  for (const TermClass of game.ffg.diceterms) {
    installKarmicPatchOnTerm(TermClass);
  }
}

/* ------------------------------------------------------------------------- */
/* Chat message hook: add Karmic summary                                    */
/* ------------------------------------------------------------------------- */

function extractKarmicChangesFromRolls(rolls) {
  const changes = [];
  if (!Array.isArray(rolls)) return changes;

  for (const roll of rolls) {
    if (!roll || !Array.isArray(roll.terms)) continue;
    for (const term of roll.terms) {
      if (!term || !Array.isArray(term.results)) continue;
      for (const res of term.results) {
        const k = res && res.karmic;
        if (!k) continue;
        if (typeof k.originalResult !== "number" || typeof k.adjustedResult !== "number") continue;
        if (k.originalResult === k.adjustedResult) continue;
        changes.push({
          dieType: k.dieType || "?",
          originalResult: k.originalResult,
          adjustedResult: k.adjustedResult
        });
      }
    }
  }
  return changes;
}

function renderKarmicSummaryList(changes) {
  if (!changes.length) return "<p>No Karmic adjustments were applied.</p>";

  const items = changes.map((chg) => {
    const table = getFfgResultTableForDenom(chg.dieType);
    const dieName = describeDenom(chg.dieType);

    const orig = table ? table[chg.originalResult] : null;
    const adj = table ? table[chg.adjustedResult] : null;

    const origLabel = orig?.label ? game.i18n.localize(orig.label) : `Face ${chg.originalResult}`;
    const adjLabel = adj?.label ? game.i18n.localize(adj.label) : `Face ${chg.adjustedResult}`;

    const origImg = orig?.image
      ? `<img src="${orig.image}" alt="${origLabel}" title="${origLabel}" />`
      : "";
    const adjImg = adj?.image
      ? `<img src="${adj.image}" alt="${adjLabel}" title="${adjLabel}" />`
      : "";

    return `<li>
      <strong>${dieName}</strong>:
      <span class="karmic-original">${origImg} ${origLabel}</span>
      &rarr;
      <span class="karmic-adjusted">${adjImg} ${adjLabel}</span>
    </li>`;
  });

  return `<ul class="karmic-dice-changes">${items.join("")}</ul>`;
}

function wrapChatContentWithKarmicSummary(originalContent, summaryHtml) {
  const safeOriginal = originalContent ?? "";

  return `
<div class="karmic-dice-card">
  ${safeOriginal}
  <details class="karmic-dice-details">
    <summary>Karmic Dice Adjustments</summary>
    ${summaryHtml}
  </details>
</div>`;
}

function handlePreCreateChatMessage(data, options, userId) {
  try {
    if (!data || !Array.isArray(data.rolls) || !data.rolls.length) return;

    const changes = extractKarmicChangesFromRolls(data.rolls);
    if (!changes.length) return;

    const summaryHtml = renderKarmicSummaryList(changes);
    data.content = wrapChatContentWithKarmicSummary(data.content, summaryHtml);

    log(`Applied Karmic summary to chat message (${changes.length} adjusted die/dice).`);
  } catch (e) {
    error("preCreateChatMessage failure", e);
  }
}

/* ------------------------------------------------------------------------- */
/* Foundry hooks                                                             */
/* ------------------------------------------------------------------------- */

Hooks.once("init", () => {
  log("Initializing Karmic Dice infrastructure (no karma rules yet).");
});

Hooks.once("ready", () => {
  try {
    installKarmicPatches();
    Hooks.on("preCreateChatMessage", handlePreCreateChatMessage);
    log("Karmic Dice ready. Dice rolls are now intercepted and tracked.");
  } catch (e) {
    error("Error during ready initialization", e);
  }
});
