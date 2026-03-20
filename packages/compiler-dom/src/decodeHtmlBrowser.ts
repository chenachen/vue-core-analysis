/* eslint-disable no-restricted-globals */

let decoder: HTMLDivElement

/**
 * 利用浏览器原生 DOM 能力解码 HTML entity。
 */
export function decodeHtmlBrowser(raw: string, asAttr = false): string {
  if (!decoder) {
    decoder = document.createElement('div')
  }
  if (asAttr) {
    decoder.innerHTML = `<div foo="${raw.replace(/"/g, '&quot;')}">`
    return decoder.children[0].getAttribute('foo')!
  } else {
    decoder.innerHTML = raw
    return decoder.textContent!
  }
}
