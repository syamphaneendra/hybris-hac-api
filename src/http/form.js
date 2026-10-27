'use strict';

/**
 * application/x-www-form-urlencoded encoding with a pinned field order.
 */

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded; charset=UTF-8';

/**
 * @typedef {Array<[string, string]>} FormFields Ordered name/value pairs.
 */

/**
 * @param {FormFields} fields
 * @returns {{ body: Buffer, contentType: string, contentLength: number }}
 */
function encodeForm(fields) {
  const body = Buffer.from(new URLSearchParams(fields).toString(), 'utf8');
  return { body, contentType: FORM_CONTENT_TYPE, contentLength: body.byteLength };
}

module.exports = { encodeForm, FORM_CONTENT_TYPE };
