'use strict';

/**
 * Hybris version parsing. Versions are compared numerically by major.minor,
 * so '5.10' is newer than '5.7'.
 */

const VERSION_PATTERN = /^\d+(\.\d+)*$/;

/**
 * @param {unknown} version e.g. '5.7', '6.7', '2205' or a number such as 5.7.
 * @returns {{ major: number, minor: number } | null} null when not numeric.
 */
function parseVersion(version) {
  if (version === undefined || version === null) return null;
  const text = String(version).trim();
  if (!VERSION_PATTERN.test(text)) return null;
  const [major, minor = '0'] = text.split('.');
  return { major: Number(major), minor: Number(minor) };
}

/**
 * True when the version is older than 5.7, which uses the per-language
 * scripting endpoint `/console/<scriptType>/execute`. Unparseable versions
 * count as modern.
 *
 * @param {unknown} version
 * @returns {boolean}
 */
function usesLegacyScriptingEndpoint(version) {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  return parsed.major < 5 || (parsed.major === 5 && parsed.minor < 7);
}

module.exports = { parseVersion, usesLegacyScriptingEndpoint };
